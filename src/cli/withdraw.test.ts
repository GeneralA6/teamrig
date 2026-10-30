import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { LockWaiter } from '../delivery/host-lock.ts';
import { KIT_VERSION } from '../core/version.ts';
import { CliHarness, KIT, TEAM } from '../testing/cli-harness.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { FakeSteps } from '../testing/fake-steps.ts';
import { withdrawalText } from './commands/withdraw.ts';

const LOCK = join(KIT, 'host.lock');
const QUEUE = `${LOCK}.queue`;
const ME = 4242;
const OTHER = 9001;
const TAB = { CLAUDE_CODE_SESSION_ID: '9f8e7d6c-1111-2222-3333-444455556666' };

/** This process and `OTHER` run, so their tickets are live. */
function running(): FakeSessionProcesses {
  return new FakeSessionProcesses()
    .add({ pid: ME, parentPid: 1, name: 'node', commandLine: 'node cli.ts queue' })
    .add({ pid: OTHER, parentPid: 1, name: 'node', commandLine: 'node cli.ts queue' });
}

/** A step of alpha's in `OTHER` waiting since `arrivedAt`, as an older teamrig queued it: it never looks for its ticket. */
function olderWaiterOf(arrivedAt: string, overrides: Partial<LockWaiter> = {}): LockWaiter {
  return { id: `w${Date.parse(arrivedAt)}`, pid: OTHER, session: 'alpha', purpose: 'heavy: build api', arrivedAt, expiresAt: '2030-01-08T11:00:10.000Z', ...overrides };
}

/** {@link olderWaiterOf} as this teamrig queues it: it names its kit and stops once its ticket is withdrawn. */
function waiterOf(arrivedAt: string, overrides: Partial<LockWaiter> = {}): LockWaiter {
  return { ...olderWaiterOf(arrivedAt, overrides), kit: KIT_VERSION, stopsOnWithdraw: true };
}

function nameOf(waiter: LockWaiter): string {
  return `${String(Date.parse(waiter.arrivedAt)).padStart(15, '0')}-${waiter.id}.json`;
}

/** Writes each waiter's ticket as teamrig, and an older one, stores it: the id under `token` (T1544). */
async function queued(kit: CliHarness, ...waiters: readonly LockWaiter[]): Promise<void> {
  for (const waiter of waiters) {
    const { id, ...rest } = waiter;
    await kit.files.write(join(QUEUE, nameOf(waiter)), JSON.stringify({ token: id, ...rest }));
  }
}

const BUILD = waiterOf('2030-01-08T09:58:00.000Z');
const SPECS = waiterOf('2030-01-08T09:59:00.000Z', { purpose: 'heavy: specs' });
const THEIRS = waiterOf('2030-01-08T09:57:00.000Z', { session: 'bravo', purpose: 'heavy: build web' });

describe('teamrig withdraw', () => {
  it("withdraws the session's waiting steps whose purpose holds --what, leaving the rest of the line", async () => {
    const kit = new CliHarness(TEAM);
    await queued(kit, BUILD, SPECS, THEIRS);
    const result = await kit.run(['withdraw', '--session', 'alpha', '--what', 'build'], { sessionProcesses: running() });
    assert.deepEqual(result, { code: 0, stdout: ['WITHDRAWN heavy: build api, waiting since 2030-01-08 09:58 UTC: it stops at its next look'], stderr: [] });
    assert.deepEqual(await kit.files.list(QUEUE), [nameOf(THEIRS), nameOf(SPECS)]);
  });

  it("withdraws each with --all, keeping one an older teamrig queued since its step runs anyway, and exits 1", async () => {
    const kit = new CliHarness(TEAM);
    const older = olderWaiterOf('2030-01-08T09:56:00.000Z', { purpose: 'merge app' });
    await queued(kit, older, BUILD, THEIRS);
    const result = await kit.run(['withdraw', '--session', 'alpha', '--all'], { sessionProcesses: running() });
    assert.deepEqual(result, {
      code: 1,
      stdout: [
        'KEPT merge app, waiting since 2030-01-08 09:56 UTC: an older teamrig queued it and runs it anyway (pid 9001)',
        'WITHDRAWN heavy: build api, waiting since 2030-01-08 09:58 UTC: it stops at its next look',
      ],
      stderr: [],
    });
    assert.deepEqual(await kit.files.list(QUEUE), [nameOf(older), nameOf(THEIRS)]);
  });

  it("lists the session's waiting steps on the team's clock and is refused, withdrawing nothing, when none is chosen", async () => {
    const kit = new CliHarness(TEAM);
    await queued(kit, BUILD, SPECS, THEIRS);
    const result = await kit.run(['withdraw', '--session', 'alpha'], { sessionProcesses: running(), timeZone: 'Asia/Jerusalem' });
    assert.deepEqual(result, {
      code: 2,
      stdout: [
        'WAITING heavy: build api, waiting since 2030-01-08 11:58 IST (pid 9001)',
        'WAITING heavy: specs, waiting since 2030-01-08 11:59 IST (pid 9001)',
        'REFUSED name the steps to withdraw: --what <text in their purpose> or --all',
      ],
      stderr: [],
    });
    assert.equal((await kit.files.list(QUEUE)).length, 3);
  });

  it('says NONE and exits 0 when no step of the session waits, chosen or not', async () => {
    const kit = new CliHarness(TEAM);
    await queued(kit, BUILD, THEIRS);
    const listed = await kit.run(['withdraw', '--session', 'bravo', '--what', 'lint'], { sessionProcesses: running() });
    const none = await kit.run(['withdraw', '--session', 'lead'], { sessionProcesses: running() });
    assert.deepEqual(
      [listed, none],
      [
        { code: 0, stdout: ['NONE no step of bravo waits for the host lock with "lint" in its purpose'], stderr: [] },
        { code: 0, stdout: ['NONE no step of lead waits for the host lock'], stderr: [] },
      ],
    );
    assert.equal((await kit.files.list(QUEUE)).length, 2);
  });

  it("takes the session this tab is bound to, and refuses another session's steps from it", async () => {
    const kit = new CliHarness(TEAM);
    await queued(kit, BUILD, THEIRS);
    await kit.run(['inbox', 'read', '--session', 'alpha'], { env: TAB });
    const theirs = await kit.run(['withdraw', '--session', 'bravo', '--all'], { env: TAB, sessionProcesses: running() });
    const own = await kit.run(['withdraw', '--all'], { env: TAB, sessionProcesses: running() });
    assert.deepEqual(
      [theirs, own.stdout],
      [{ code: 2, stdout: ["REFUSED this tab is alpha's: a session withdraws only its own steps, not bravo's"], stderr: [] }, ['WITHDRAWN heavy: build api, waiting since 2030-01-08 09:58 UTC: it stops at its next look']],
    );
    assert.deepEqual(await kit.files.list(QUEUE), [nameOf(THEIRS)]);
  });

  it('is a usage error given both --what and --all, a blank --what, or no session outside a bound tab', async () => {
    const kit = new CliHarness(TEAM);
    const codes = [
      (await kit.run(['withdraw', '--session', 'alpha', '--what', 'build', '--all'])).code,
      (await kit.run(['withdraw', '--session', 'alpha', '--what', ' '])).code,
      (await kit.run(['withdraw', '--all'], { env: TAB })).code,
    ];
    assert.deepEqual(codes, [64, 64, 64]);
  });

  it('stops a queued step waiting for the lock, which then runs and records nothing', async () => {
    const kit = new CliHarness(TEAM);
    const steps = new FakeSteps(kit.clock);
    const held = JSON.stringify({ token: 'other', pid: OTHER, session: 'bravo', purpose: 'heavy: build web', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z' });
    await kit.files.write(LOCK, held);
    let withdrew: readonly string[] = [];
    const sleep = async (ms: number): Promise<void> => {
      await kit.clock.sleep(ms);
      if (withdrew.length === 0) {
        withdrew = (await kit.run(['withdraw', '--session', 'alpha', '--what', 'build api'], { sessionProcesses: running() })).stdout;
      }
    };
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'build api', '--', 'npm', 'run', 'build'], { steps, sessionProcesses: running(), sleep });
    assert.deepEqual(withdrew, ['WITHDRAWN heavy: build api, waiting since 2030-01-08 10:00 UTC: it stops at its next look']);
    assert.deepEqual([result.code, result.stdout.at(-1), steps.ran, kit.files.get(LOCK), await kit.files.list(QUEUE)], [
      2,
      "REFUSED withdrawn from the host lock's line (teamrig withdraw): build api did not run",
      [],
      held,
      [],
    ]);
  });
});

describe('withdrawalText', () => {
  it('names a step that went first, running or gone, and the process of one that runs', () => {
    assert.deepEqual(
      [withdrawalText({ kind: 'running', waiter: BUILD }, JERUSALEM), withdrawalText({ kind: 'left', waiter: BUILD }, JERUSALEM)],
      ['RUNNING heavy: build api: it took its turn first and runs (pid 9001)', 'LEFT heavy: build api: it left the line first, having run or given up'],
    );
  });

  it("shows a withdrawn or kept step's wait on the zone's clock", () => {
    assert.deepEqual(
      [withdrawalText({ kind: 'withdrawn', waiter: BUILD }, JERUSALEM), withdrawalText({ kind: 'kept', waiter: BUILD }, JERUSALEM)],
      [
        'WITHDRAWN heavy: build api, waiting since 2030-01-08 11:58 IST: it stops at its next look',
        'KEPT heavy: build api, waiting since 2030-01-08 11:58 IST: an older teamrig queued it and runs it anyway (pid 9001)',
      ],
    );
  });
});
