import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FIRST_IN_LINE_POLL_MS } from '../delivery/host-lock.ts';
import type { QueuedStepRecord, RefusalOutcome, RefusalRecord } from '../delivery/ledger.ts';
import { recordPass } from '../delivery/push-pass.ts';
import { KIT_VERSION } from '../core/version.ts';
import { APP, CliHarness, KIT, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { BUSY_HOLDERS, BUSY_HOLDERS_TEXT, FakeHostMemory } from '../testing/fake-host-memory.ts';
import { cleanTree, FakeTrees, GIT_DIR } from '../testing/fake-trees.ts';
import { FakeStarterWatch, SHELL } from '../testing/fake-starter-watch.ts';
import { FakeSteps } from '../testing/fake-steps.ts';
import { heldBy, OTHER, otherRuns } from '../testing/held-lock.ts';
import { lineRequests } from '../testing/line-tickets.ts';
import { ROOMY_FREE_MB } from '../testing/quiet-world.ts';
import { EXIT } from './runtime.ts';

const LEDGER = join(TEAM_HOME, 'state', 'deploys', 'ledger.jsonl');
const LOCK = join(KIT, 'host.lock');
const SHARED = `${LOCK}.shared`;
const MINUTE = 60_000;

/** The team config with admission `serial`, where a heavy step takes the lock file: the pipeline's default shares the host. */
const SERIAL = { ...TEAM, delivery: { queue: { admission: 'serial' } } };

/** The line of a heavy step admitted at `stamp` as the only heavy share, its 2048 MB held, with roomy free memory. */
function heavyShared(stamp: string): string {
  return `${stamp} sharing the host as a heavy step: 2048 MB held for it (${ROOMY_FREE_MB} MB free, 0 other heavy steps)`;
}

function ledgerOf(kit: CliHarness, path: string = LEDGER): unknown[] {
  return (kit.files.get(path) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

function harness(config: Readonly<Record<string, unknown>> = TEAM): { kit: CliHarness; steps: FakeSteps } {
  const kit = new CliHarness(config);
  return { kit, steps: new FakeSteps(kit.clock) };
}

const BUILD = ['queue', '--session', 'alpha', '--what', 'build api', '--', 'npm', 'run', 'build'];

/** A queued step's label and the kind of work its command does. */
type Step = Pick<RefusalRecord, 'what' | 'kind'>;

const BUILD_STEP: Step = { what: 'build api', kind: 'build' };
const SPECS_STEP: Step = { what: 'specs', kind: 'test' };

/** The refusal record of alpha's `step`, which began to wait at 10:00 with `freeMb` free and ended without running, the free memory unchanged. */
function refused(step: Step, freeMb: number, end: Pick<RefusalRecord, 'endedAt' | 'outcome' | 'reason' | 'waits' | 'lastWait'>): RefusalRecord {
  return { type: 'refusal', id: 'id-2', session: 'alpha', ...step, kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', ...end, queueFreeMb: freeMb, endFreeMb: freeMb };
}

/** The refusal record of alpha's `build api`, which waited on po's lock (`heldBy`) until `endedAt` and did not run. */
function buildRefused(endedAt: string, lockMs: number, outcome: RefusalOutcome, reason: string): RefusalRecord {
  const lastWait = { cause: 'lock', text: 'waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC' } as const;
  return refused(BUILD_STEP, ROOMY_FREE_MB, { endedAt, outcome, reason, waits: { lock: lockMs }, lastWait });
}

/** The refusal record of alpha's `step`, refused at 10:01 after a minute's wait on host memory stuck at `freeMb`: `waiting` starts its wait line. */
function memoryRefused(step: Step, freeMb: number, waiting: string, short: string): RefusalRecord {
  const lastWait = { cause: 'memory', text: `${waiting}: ${short}` } as const;
  return refused(step, freeMb, { endedAt: '2030-01-08T10:01:00.000Z', outcome: 'timedOut', reason: `host memory still short: ${short}`, waits: { memory: MINUTE }, lastWait });
}

const SPECS = ['queue', '--session', 'alpha', '--what', 'specs', '--small', '--', 'npm', 'test'];

/** A small step sharing the host: po's spec run, taken at 09:50 by `OTHER`, 2048 MB held for it. */
function sharedBy(): string {
  return JSON.stringify({ token: 'other', pid: OTHER, session: 'po', purpose: 'heavy: specs', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z', reserveMb: 2048 });
}

/** A small step of alpha's own sharing the host: `purpose`, taken at 09:50 by `OTHER` under `token`, 2048 MB held for it. */
function ownShare(token: string, purpose: string): string {
  return JSON.stringify({ token, pid: OTHER, session: 'alpha', purpose, kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z', reserveMb: 2048 });
}

/** What else an earlier run recorded: its kind of work, and the host's free memory when it started and at its lowest. */
type RanAlso = Partial<Pick<QueuedStepRecord, 'kind' | 'startFreeMb' | 'lowFreeMb'>>;

/** An ended run of `what` by `session` the day before, whose process tree held `peakTreeMb` at most, with `also`. */
function ranBefore(session: string, what: string, peakTreeMb: number, also: RanAlso = {}): string {
  return JSON.stringify({ type: 'heavy', id: `${session}-${peakTreeMb}`, session, what, ...also, startedAt: '2030-01-07T10:00:00.000Z', endedAt: '2030-01-07T10:05:00.000Z', exitCode: 0, peakTreeMb });
}

describe('teamrig queue', () => {
  it('shares the host as a heavy step under the default pipeline admission, its share marked heavy and the lock file free, recorded as not shared (T2210)', async () => {
    const { kit, steps } = harness();
    let whileRunning: unknown[] = [];
    steps.ends(0, 5 * MINUTE).whileRunning(async () => {
      whileRunning = [kit.files.get(LOCK), JSON.parse(kit.files.get(`${SHARED}/id-1.json`) ?? '{}')];
    });
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual(result, { code: 0, stdout: [heavyShared('2030-01-08 10:00:02 UTC'), '2030-01-08 10:00:02 UTC running: build api (killed after 45m)', 'DONE exit 0'], stderr: [] });
    const request = { kind: 'build', class: 'Improvements', classPct: 15, needMb: 2048, heavy: true, exclusive: false };
    const share = { token: 'id-1', pid: 4242, session: 'alpha', purpose: 'heavy: build api', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:00:02.000Z', expiresAt: '2030-01-08T12:30:02.000Z', reserveMb: 2048, heavy: true, request };
    assert.deepEqual(whileRunning, [undefined, share]);
    assert.equal(kit.files.get(`${SHARED}/id-1.json`), undefined, 'the share is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:05:02.000Z', exitCode: 0 }], 'a heavy share is not recorded as shared: that marks a small step');
  });

  it('runs the command under the host lock with delivery.queue.admission serial, records its start and end, and prints DONE', async () => {
    const { kit, steps } = harness(SERIAL);
    let lockWhileRunning: unknown;
    steps.ends(0, 5 * MINUTE).whileRunning(async () => {
      lockWhileRunning = JSON.parse(kit.files.get(LOCK) ?? '{}');
    });
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual(result, { code: 0, stdout: ['2030-01-08 10:00:02 UTC running: build api (killed after 45m)', 'DONE exit 0'], stderr: [] });
    assert.deepEqual(lockWhileRunning, {
      token: 'id-1',
      pid: 4242,
      session: 'alpha',
      purpose: 'heavy: build api',
      kit: KIT_VERSION,
      acquiredAt: '2030-01-08T10:00:02.000Z',
      expiresAt: '2030-01-08T12:30:02.000Z',
    });
    assert.equal(kit.files.get(LOCK), undefined, 'the lock is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:05:02.000Z', exitCode: 0 }]);
  });

  it('runs the command line in the shell, in the current folder with the environment as it is, limited to 45 minutes', async () => {
    const { kit, steps } = harness();
    await kit.run(['queue', '--session', 'alpha', '--what', 'tests', '--', 'node', '--test', 'src/**/*.test.ts'], { steps, env: { PROBE: 'yes' } });
    const [request] = steps.ran;
    assert.equal(request?.command, "node --test 'src/**/*.test.ts'");
    assert.equal(request?.cwd, APP);
    assert.equal(request?.env['PROBE'], 'yes');
    assert.equal(request?.timeoutMs, 45 * MINUTE);
  });

  it('prints FAILED with the exit code and records it', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(BUILD, { steps: steps.ends(3) });
    assert.deepEqual([result.code, result.stdout.at(-1)], [1, 'FAILED exit 3']);
    assert.deepEqual(ledgerOf(kit).map((record) => JSON.stringify(record).includes('"exitCode":3')), [false, true]);
    assert.equal(kit.files.get(LOCK), undefined);
  });

  it('prints TIMED OUT for a step killed at its limit, recorded as exit 124', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(BUILD, { steps: steps.ends({ kind: 'timedOut' }, 45 * MINUTE) });
    assert.deepEqual(result, {
      code: 1,
      stdout: [
        heavyShared('2030-01-08 10:00:02 UTC'),
        '2030-01-08 10:00:02 UTC running: build api (killed after 45m)',
        '2030-01-08 10:45:02 UTC timed out after 45m: killed its process tree',
        'TIMED OUT killed, recorded as exit 124',
      ],
      stderr: [],
    });
    assert.deepEqual(ledgerOf(kit)[1], { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: '2030-01-08T10:45:02.000Z', exitCode: 124, endFreeMb: ROOMY_FREE_MB });
  });

  it('prints FAILED for a step a signal stopped, recorded as exit 1', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(BUILD, { steps: steps.ends({ kind: 'signal', signal: 'SIGTERM' }) });
    assert.deepEqual([result.code, result.stdout.at(-1)], [1, 'FAILED stopped by SIGTERM, recorded as exit 1']);
  });

  it('records a step that could not start as exit 1 and releases the lock', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(BUILD, { steps: steps.failsWith(new Error('spawn cmd.exe ENOENT')) });
    assert.deepEqual([result.code, result.stderr], [1, ['FAILED spawn cmd.exe ENOENT']]);
    assert.deepEqual(ledgerOf(kit).map((record) => JSON.stringify(record).endsWith('"exitCode":1}')), [false, true]);
    assert.equal(kit.files.get(LOCK), undefined);
  });

  it('kills the step after --max-minutes', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'replay', '--max-minutes', '90', '--', 'npm', 'run', 'replay'], { steps });
    assert.equal(result.stdout[1], '2030-01-08 10:00:02 UTC running: replay (killed after 1h30m)');
    assert.equal(steps.ran[0]?.timeoutMs, 90 * MINUTE);
  });

  for (const minutes of ['0', '141', '1.5', 'soon']) {
    it(`refuses --max-minutes ${minutes} before taking the lock`, async () => {
      const { kit, steps } = harness();
      const result = await kit.run(['queue', '--session', 'alpha', '--what', 'replay', '--max-minutes', minutes, '--', 'npm', 'test'], { steps });
      assert.equal(result.code, 64);
      assert.match(result.stderr.join('\n'), /--max-minutes is a whole number from 1 to 140 \(delivery\.queue\.lockTtlMinutes less 10\)/);
      assert.deepEqual([steps.ran, kit.files.get(LOCK)], [[], undefined]);
    });
  }

  it('refuses from the queue cutoff on, before taking the lock', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { schedule: { queueCutoffUtc: '09:30' } } });
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual(result, { code: 2, stdout: ['REFUSED queue cutoff 09:30-00:00 UTC (now 10:00 UTC)'], stderr: [] });
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER)], [[], undefined, undefined]);
  });

  it("names the cutoff on the team's clock", async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { schedule: { queueCutoffUtc: '09:30' } } });
    const result = await kit.run(BUILD, { steps, timeZone: 'Asia/Jerusalem' });
    assert.deepEqual(result, { code: 2, stdout: ['REFUSED queue cutoff 11:30-02:00 IST (now 12:00 IST)'], stderr: [] });
  });

  it("stamps its progress lines on the team's clock", async () => {
    const { kit, steps } = harness();
    steps.ends(0, MINUTE);
    const result = await kit.run(BUILD, { steps, timeZone: 'Asia/Jerusalem' });
    assert.deepEqual(result.stdout, [heavyShared('2030-01-08 12:00:02 IST'), '2030-01-08 12:00:02 IST running: build api (killed after 45m)', 'DONE exit 0']);
  });

  it('waits for a held lock, and refuses when the wait ran past the cutoff, recording its refusal', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { schedule: { queueCutoffUtc: '10:30' } } });
    await kit.files.write(LOCK, heldBy('2030-01-08T10:40:00.000Z'));
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    assert.deepEqual(result, {
      code: 2,
      stdout: ['2030-01-08 10:00:00 UTC waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC', 'REFUSED queue cutoff 10:30-00:00 UTC (now 10:40 UTC)'],
      stderr: [],
    });
    const refusal = buildRefused('2030-01-08T10:40:02.000Z', 40 * MINUTE + FIRST_IN_LINE_POLL_MS, 'refused', 'queue cutoff 10:30-00:00 UTC (now 10:40 UTC)');
    const expired = heldBy('2030-01-08T10:40:00.000Z');
    assert.deepEqual([steps.ran, kit.files.get(LOCK), ledgerOf(kit)], [[], expired, [refusal]], 'a share leaves the expired lock for the next step that takes the lock');
  });

  it('refuses when the lock is still held after the wait, leaving it to its holder and recording its refusal', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    assert.deepEqual(result, {
      code: 2,
      stdout: ['2030-01-08 10:00:00 UTC waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC', 'REFUSED host lock still held by po (heavy: build) since 2030-01-08 09:50 UTC'],
      stderr: [],
    });
    assert.deepEqual(kit.clock.sleeps, Array.from({ length: MINUTE / FIRST_IN_LINE_POLL_MS }, () => FIRST_IN_LINE_POLL_MS), 'the first in line looks every 2 s');
    assert.equal(kit.files.get(LOCK), heldBy());
    assert.deepEqual(ledgerOf(kit), [buildRefused('2030-01-08T10:01:00.000Z', MINUTE, 'timedOut', 'host lock still held by po (heavy: build) since 2030-01-08 09:50 UTC')]);
  });

  it('refuses, running nothing and recording its refusal, when its ticket is withdrawn while it waits, leaving the lock to its holder', async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const queue = `${LOCK}.queue`;
    const sleep = async (ms: number): Promise<void> => {
      await kit.clock.sleep(ms);
      for (const name of await kit.files.list(queue)) {
        await kit.files.remove(join(queue, name));
      }
    };
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns(), sleep });
    assert.deepEqual(result, {
      code: 2,
      stdout: ['2030-01-08 10:00:00 UTC waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC', "REFUSED withdrawn from the host lock's line (teamrig withdraw): build api did not run"],
      stderr: [],
    });
    const refusal = buildRefused('2030-01-08T10:00:02.000Z', 2_000, 'withdrawn', "withdrawn from the host lock's line (teamrig withdraw): build api did not run");
    assert.deepEqual([steps.ran, kit.files.get(LOCK), ledgerOf(kit), await kit.files.list(queue)], [[], heldBy(), [refusal], []]);
  });

  it('records when the step began to wait, how long the lock held it, and what its process tree and the host held while it ran', async () => {
    const { kit, steps } = harness();
    steps.ends(0, 5 * MINUTE);
    const memory = new FakeHostMemory(ROOMY_FREE_MB).measures({ peakTreeMb: 1900, lowFreeMb: 6400 });
    await kit.files.write(LOCK, heldBy('2030-01-08T10:03:00.000Z'));
    assert.equal((await kit.run(BUILD, { steps, memory, sessionProcesses: otherRuns() })).code, 0);
    assert.deepEqual(memory.watches, [{ root: 4242, intervalMs: 15_000, stopped: true }], "its own process's tree, every 15 s");
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', waits: { lock: 3 * MINUTE + 2_000 }, queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:03:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:08:02.000Z', exitCode: 0, peakTreeMb: 1900, lowFreeMb: 6400 }]);
  });

  it('watches no memory when the config samples it every 0 seconds', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { memorySampleSeconds: 0 } } });
    const memory = new FakeHostMemory(ROOMY_FREE_MB).measures({ peakTreeMb: 1900, lowFreeMb: 6400 });
    assert.equal((await kit.run(BUILD, { steps, memory })).code, 0);
    assert.deepEqual(memory.watches, []);
    assert.equal(ledgerOf(kit).some((record) => JSON.stringify(record).includes('peakTreeMb')), false);
  });

  it('stops waiting for the lock once the shell that started it ended, leaving the lock to its holder and recording its refusal', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { wait: { pollSeconds: 30 } } });
    await kit.files.write(LOCK, heldBy());
    const starters = new FakeStarterWatch();
    const sleep = async (ms: number): Promise<void> => {
      await kit.clock.sleep(ms);
      starters.end();
    };
    const result = await kit.run(BUILD, { steps, starters, sleep, sessionProcesses: otherRuns() });
    assert.deepEqual(result, {
      code: 1,
      stdout: [
        '2030-01-08 10:00:00 UTC waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC',
        '2030-01-08 10:00:02 UTC its launching shell ended (bash.exe 4100) while it waited: no one waits for it any more',
        'STOPPED before the host lock was free: nothing ran',
      ],
      stderr: [],
    });
    const refusal = buildRefused('2030-01-08T10:00:02.000Z', 2_000, 'stopped', 'its launching shell ended (bash.exe 4100) while it waited');
    assert.deepEqual([steps.ran, kit.files.get(LOCK), ledgerOf(kit), starters.openWatches], [[], heldBy(), [refusal], 0]);
  });

  it('kills a running step once the shell that started it ended, records exit 129 and frees the lock', async () => {
    const { kit, steps } = harness();
    const starters = new FakeStarterWatch();
    steps.ends(0, MINUTE).whileRunning(async () => starters.end());
    const result = await kit.run(BUILD, { steps, starters });
    assert.deepEqual(result, {
      code: 1,
      stdout: [
        heavyShared('2030-01-08 10:00:02 UTC'),
        '2030-01-08 10:00:02 UTC running: build api (killed after 45m)',
        '2030-01-08 10:00:02 UTC its launching shell ended (bash.exe 4100): killed its process tree',
        'STOPPED killed, recorded as exit 129',
      ],
      stderr: [],
    });
    assert.equal(steps.ran[0]?.stop?.aborted, true);
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:00:02.000Z', exitCode: 129, endFreeMb: ROOMY_FREE_MB }]);
    assert.deepEqual([kit.files.get(LOCK), starters.openWatches], [undefined, 0]);
  });

  it("kills a step run under its parent's lock once its shell ended, leaving the parent's lock", async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const starters = new FakeStarterWatch([SHELL]);
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'pre-commit checks', '--', 'npm', 'test'], {
      steps: steps.whileRunning(async () => starters.end(SHELL)),
      starters,
      sessionProcesses: otherRuns(),
      env: { TEAMRIG_HOST_LOCK: 'other' },
    });
    assert.deepEqual([result.code, result.stdout.at(-1), kit.files.get(LOCK), starters.openWatches], [1, 'STOPPED killed, recorded as exit 129', heldBy(), 0]);
  });

  it('says when it cannot list the processes that started it, and runs the step as usual', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(BUILD, { steps, starters: new FakeStarterWatch([]) });
    assert.deepEqual(result.stdout, [
      '2030-01-08 10:00:00 UTC could not list the processes that started this one: the step runs on if its shell ends',
      heavyShared('2030-01-08 10:00:02 UTC'),
      '2030-01-08 10:00:02 UTC running: build api (killed after 45m)',
      'DONE exit 0',
    ]);
  });

  it('takes over a lock its process left behind with delivery.queue.admission serial', async () => {
    const { kit, steps } = harness(SERIAL);
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps });
    assert.deepEqual([result.code, result.stdout.at(-1), kit.files.get(LOCK)], [0, 'DONE exit 0', undefined]);
  });

  it("gives its command the lock's id, so a queued step the command starts runs under this lock", async () => {
    const { kit, steps } = harness();
    await kit.run(BUILD, { steps });
    assert.equal(steps.ran[0]?.env['TEAMRIG_HOST_LOCK'], 'id-1');
  });

  it("runs a step its parent's live lock covers at once, in the parent's session, without a ledger record", async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(['queue', '--what', 'pre-commit checks', '--', 'npm', 'test'], {
      steps: steps.ends(0, MINUTE),
      sessionProcesses: otherRuns(),
      env: { TEAMRIG_HOST_LOCK: 'other' },
    });
    assert.deepEqual(result, {
      code: 0,
      stdout: ['2030-01-08 10:00:00 UTC running: pre-commit checks under the host lock of po (heavy: build) since 2030-01-08 09:50 UTC (killed after 45m)', 'DONE exit 0'],
      stderr: [],
    });
    assert.deepEqual([steps.ran.length, steps.ran[0]?.env['TEAMRIG_HOST_LOCK'], kit.clock.sleeps], [1, 'other', []]);
    assert.deepEqual([kit.files.get(LOCK), kit.files.get(LEDGER)], [heldBy(), undefined], "the parent's lock stays, and its record covers the step");
  });

  it('runs under a parent lock even from the queue cutoff on, since its parent started before it', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { schedule: { queueCutoffUtc: '09:30' } } });
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns(), env: { TEAMRIG_HOST_LOCK: 'other' } });
    assert.deepEqual([result.code, steps.ran.length], [0, 1]);
  });

  /** The lock taken carries its ticket's id, also when taking it first removes a lock left behind. */
  for (const [label, lock] of [
    ['a lock its process left behind', heldBy()],
    ['no lock at all', undefined],
  ] as const) {
    it(`takes the lock as usual when $TEAMRIG_HOST_LOCK names ${label}, with delivery.queue.admission serial`, async () => {
      const { kit, steps } = harness(SERIAL);
      if (lock !== undefined) {
        await kit.files.write(LOCK, lock);
      }
      const result = await kit.run(BUILD, { steps, env: { TEAMRIG_HOST_LOCK: 'other' } });
      assert.deepEqual(result.stdout.slice(0, 2), [
        '2030-01-08 10:00:00 UTC $TEAMRIG_HOST_LOCK names no live host lock: taking the lock as usual',
        '2030-01-08 10:00:02 UTC running: build api (killed after 45m)',
      ]);
      assert.deepEqual([result.code, steps.ran[0]?.env['TEAMRIG_HOST_LOCK'], ledgerOf(kit).length], [0, 'id-1', 2]);
    });
  }

  it('waits for a live lock whose id is not the one in $TEAMRIG_HOST_LOCK', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns(), env: { TEAMRIG_HOST_LOCK: 'someone-else' } });
    assert.deepEqual([result.code, steps.ran, kit.files.get(LOCK)], [2, [], heldBy()]);
  });

  it('takes the session this Claude Code tab is bound to when none is named', async () => {
    const { kit, steps } = harness();
    const tab = { CLAUDE_CODE_SESSION_ID: '9f8e7d6c-1111-2222-3333-444455556666' };
    await kit.run(['inbox', 'read', '--session', 'alpha'], { env: tab });
    const result = await kit.run(['queue', '--what', 'pre-commit checks', '--', 'npm', 'test'], { steps, env: tab });
    assert.equal(result.code, 0);
    assert.deepEqual(
      ledgerOf(kit).map((record) => JSON.stringify(record).includes('"session":"alpha"')),
      [true, true],
    );
  });

  it('prints the usage when no session is named and the tab is bound to none', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['queue', '--what', 'build', '--', 'npm', 'test'], { steps, env: { CLAUDE_CODE_SESSION_ID: '9f8e7d6c-1111-2222-3333-444455556666' } });
    assert.deepEqual([result.code, steps.ran], [64, []]);
  });

  it("keeps the lock and ledger where the team's config puts them", async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { dir: 'data/deploys', queue: { lockPath: 'data/deploys/host.lock', admission: 'serial' } } });
    const lock = join(TEAM_HOME, 'data', 'deploys', 'host.lock');
    let lockWhileRunning: string | undefined;
    steps.whileRunning(async () => {
      lockWhileRunning = kit.files.get(lock);
    });
    await kit.run(BUILD, { steps });
    assert.equal(JSON.parse(lockWhileRunning ?? '{}').session, 'alpha');
    assert.equal(ledgerOf(kit, join(TEAM_HOME, 'data', 'deploys', 'ledger.jsonl')).length, 2);
  });

  it('refuses a session not on the team', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['queue', '--session', 'zulu', '--what', 'build', '--', 'npm', 'test'], { steps });
    assert.equal(result.code, 2);
    assert.deepEqual([steps.ran, kit.files.get(LOCK)], [[], undefined]);
  });

  it('refuses teamrig heavy, its old name, with the new one and exit 64, running nothing', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['heavy', '--session', 'alpha', '--what', 'build', '--', 'npm', 'test'], { steps });
    assert.deepEqual([result.code, result.stdout, result.stderr[0]?.split('\n')[0]], [EXIT.usage, [], 'heavy was renamed: use queue']);
    assert.deepEqual([steps.ran, kit.files.get(LOCK)], [[], undefined]);
  });

  for (const [label, argv] of [
    ['no session', ['queue', '--what', 'build', '--', 'npm', 'test']],
    ['no label', ['queue', '--session', 'alpha', '--', 'npm', 'test']],
    ['no command', ['queue', '--session', 'alpha', '--what', 'build', '--']],
    ['a word before --', ['queue', '--session', 'alpha', '--what', 'build', 'npm', '--', 'test']],
  ] as const) {
    it(`prints the usage for ${label}`, async () => {
      const { kit, steps } = harness();
      const result = await kit.run(argv, { steps });
      assert.equal(result.code, 64);
      assert.deepEqual(steps.ran, []);
    });
  }

  for (const [label, flags, what, command, request] of [
    ['given with --kind and --task', ['--kind', 'test', '--task', 'T7'], 'build api', ['npm', 'run', 'build'], { kind: 'test', task: 'T7' }],
    ['read from its command and the task its label names', [], 'teamrig T2192 specs', ['node', '--test', 'a.test.ts'], { kind: 'test', task: 'T2192' }],
    ['read from its command, with no task when its label names none', [], 'checks', ['npm', 'run', 'check'], { kind: 'other' }],
  ] as const) {
    it(`records the kind of work and the task ${label} on its start and end records (T2209)`, async () => {
      const { kit, steps } = harness();
      steps.ends(0, MINUTE);
      assert.equal((await kit.run(['queue', '--session', 'alpha', '--what', what, ...flags, '--', ...command], { steps })).code, 0);
      const start = { type: 'heavy', id: 'id-2', session: 'alpha', what, ...request, kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
      assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:01:02.000Z', exitCode: 0 }]);
    });
  }

  it("records the register priority of the task its label names on its start and end records (T2209)", async () => {
    const { kit, steps } = harness();
    const added = await kit.run(['add', '--title', 'Ship the build', '--description', 'what and why', '--priority', 'p2', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    steps.ends(0, MINUTE);
    assert.equal((await kit.run(['queue', '--session', 'alpha', '--what', 'T1 build', '--', 'npm', 'run', 'build'], { steps })).code, 0);
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'T1 build', kind: 'build', task: 'T1', priority: 2, kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:01:02.000Z', exitCode: 0 }]);
  });

  it("puts what the step asks on its ticket in the host lock's line: its kind, the task its label names with that task's priority and class, and the memory it needs (T2210)", async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    const added = await kit.run(['add', '--title', 'Ship the build', '--description', 'what and why', '--priority', 'p2', '--class', 'Maintenance', '--session', 'alpha']);
    assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    await kit.files.write(LOCK, heldBy());
    const requests: unknown[] = [];
    const sleep = async (ms: number): Promise<void> => {
      requests.push(...(await lineRequests(kit.files, LOCK)));
      await kit.clock.sleep(ms);
    };
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'T1 build', '--', 'npm', 'run', 'build'], { steps, sessionProcesses: otherRuns(), sleep });
    assert.equal(result.code, 2, 'po holds the lock past the wait');
    const request = { kind: 'build', task: 'T1', priority: 2, class: 'Maintenance', classPct: 25, needMb: 2048, heavy: true, exclusive: false };
    assert.deepEqual([requests.length > 0, requests.filter((seen) => !isDeepStrictEqual(seen, request))], [true, []]);
  });

  for (const [flag, value, message] of [
    ['--kind', 'tests', /--kind is one of build, test, lint, push, merge, deploy, other/],
    ['--task', 'merge', /--task is a register task id, such as T12/],
    ['--task', 'T0', /--task is a register task id, such as T12/],
    ['--memory-mb', '0', /--memory-mb is a whole number of MB from 1/],
    ['--memory-mb', 'x', /--memory-mb is a whole number of MB from 1/],
    ['--memory-mb', '1.5', /--memory-mb is a whole number of MB from 1/],
  ] as const) {
    it(`refuses ${flag} ${value} as a usage error, before it waits or records anything (T2209)`, async () => {
      const { kit, steps } = harness();
      const result = await kit.run(['queue', '--session', 'alpha', '--what', 'build api', flag, value, '--', 'npm', 'run', 'build'], { steps });
      assert.equal(result.code, EXIT.usage);
      assert.match(result.stderr.join('\n'), message);
      assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER)], [[], undefined, undefined]);
    });
  }
});

describe('teamrig queue --small', () => {
  it('shares the host instead of taking the lock, holds its share, which says what the step asks, while it runs and records it as shared (T2210)', async () => {
    const { kit, steps } = harness();
    let whileRunning: unknown[] = [];
    steps.ends(0, 5 * MINUTE).whileRunning(async () => {
      whileRunning = [kit.files.get(LOCK), JSON.parse(kit.files.get(`${SHARED}/id-1.json`) ?? '{}')];
    });
    const result = await kit.run(SPECS, { steps });
    const lines = [`2030-01-08 10:00:02 UTC sharing the host: 2048 MB held for it (${ROOMY_FREE_MB} MB free, 0 other small steps)`, '2030-01-08 10:00:02 UTC running: specs (killed after 10m)', 'DONE exit 0'];
    assert.deepEqual(result, { code: 0, stdout: lines, stderr: [] });
    const request = { kind: 'test', class: 'Improvements', classPct: 15, needMb: 2048, heavy: false, exclusive: false };
    const share = { token: 'id-1', pid: 4242, session: 'alpha', purpose: 'heavy: specs', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:00:02.000Z', expiresAt: '2030-01-08T12:30:02.000Z', reserveMb: 2048, request };
    assert.deepEqual(whileRunning, [undefined, share], 'a step whose label names no task asks at the default class, with no priority');
    assert.equal(kit.files.get(`${SHARED}/id-1.json`), undefined, 'the share is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'specs', kind: 'test', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, shared: true, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:05:02.000Z', exitCode: 0 }]);
  });

  it('kills it after delivery.queue.smallMaxRunMinutes, or a shorter --max-minutes', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { smallMaxRunMinutes: 12 } } });
    assert.equal((await kit.run(SPECS, { steps })).stdout[1], '2030-01-08 10:00:02 UTC running: specs (killed after 12m)');
    const shorter = ['queue', '--session', 'alpha', '--what', 'specs', '--small', '--max-minutes', '5', '--', 'npm', 'test'];
    assert.equal((await kit.run(shorter, { steps })).stdout[1], '2030-01-08 10:00:04 UTC running: specs (killed after 5m)');
    assert.deepEqual(steps.ran.map((request) => request.timeoutMs), [12 * MINUTE, 5 * MINUTE]);
  });

  it('refuses a --max-minutes past delivery.queue.smallMaxRunMinutes before sharing the host', async () => {
    const { kit, steps } = harness();
    const longer = ['queue', '--session', 'alpha', '--what', 'specs', '--small', '--max-minutes', '11', '--', 'npm', 'test'];
    const result = await kit.run(longer, { steps });
    assert.equal(result.code, 64);
    assert.match(result.stderr.join('\n'), /--max-minutes with --small is a whole number from 1 to 10 \(delivery\.queue\.smallMaxRunMinutes\): a longer step runs without --small/);
    assert.deepEqual([steps.ran, kit.files.get(`${SHARED}/id-1.json`), kit.files.get(LOCK)], [[], undefined, undefined]);
  });

  it('holds for it the most its latest 20 runs under the same session and label held, with a quarter more', async () => {
    const { kit, steps } = harness();
    const runs = [ranBefore('alpha', 'specs', 9000), ...Array.from({ length: 19 }, () => ranBefore('alpha', 'specs', 1000)), ranBefore('alpha', 'specs', 1900)];
    await kit.files.append(LEDGER, `${[...runs, ranBefore('bravo', 'specs', 9000), ranBefore('alpha', 'lint', 9000)].join('\n')}\n`);
    steps.ends(0, MINUTE);
    const { stdout } = await kit.run(SPECS, { steps });
    assert.equal(stdout[0], `2030-01-08 10:00:02 UTC sharing the host: 2375 MB held for it (${ROOMY_FREE_MB} MB free, 0 other small steps)`);
  });

  it('joins a small step sharing the host while the memory allows it', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { smallReserveMb: 1000, memoryFloorMb: 4000 } } });
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    steps.ends(0, MINUTE);
    const { stdout } = await kit.run(SPECS, { steps, sessionProcesses: otherRuns() });
    assert.equal(stdout[0], `2030-01-08 10:00:02 UTC sharing the host: 1000 MB held for it (${ROOMY_FREE_MB} MB free, 1 other small step)`);
  });

  it('waits by default while its session runs 2 steps, the pipeline cap, then refuses, recording its refusal (T2210)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(`${SHARED}/a1.json`, ownShare('a1', 'heavy: lint'));
    await kit.files.append(`${SHARED}/a2.json`, ownShare('a2', 'heavy: build'));
    const result = await kit.run(SPECS, { steps, sessionProcesses: otherRuns() });
    const capped = '2 steps of its session running, its cap 2: alpha (heavy: lint) since 2030-01-08 09:50 UTC, alpha (heavy: build) since 2030-01-08 09:50 UTC';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:00 UTC waiting to share the host: ${capped}`, `REFUSED session cap still reached: ${capped}`], stderr: [] });
    const lastWait = { cause: 'session', text: `waiting to share the host: ${capped}` } as const;
    const refusal = refused(SPECS_STEP, ROOMY_FREE_MB, { endedAt: '2030-01-08T10:01:00.000Z', outcome: 'timedOut', reason: `session cap still reached: ${capped}`, waits: { session: MINUTE }, lastWait });
    assert.deepEqual([steps.ran, ledgerOf(kit)], [[], [refusal]]);
  });

  it('shares the host beside its session\'s 2 running steps with delivery.queue.admission serial (T2210)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { admission: 'serial' } } });
    await kit.files.append(`${SHARED}/a1.json`, ownShare('a1', 'heavy: lint'));
    await kit.files.append(`${SHARED}/a2.json`, ownShare('a2', 'heavy: build'));
    steps.ends(0, MINUTE);
    const { stdout } = await kit.run(SPECS, { steps, sessionProcesses: otherRuns() });
    assert.equal(stdout[0], `2030-01-08 10:00:02 UTC sharing the host: 2048 MB held for it (${ROOMY_FREE_MB} MB free, 2 other small steps)`);
  });

  it('waits while the small steps sharing the host hold the memory it needs, then refuses, recording its refusal', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    const result = await kit.run(SPECS, { steps, memory: new FakeHostMemory(6000), sessionProcesses: otherRuns() });
    const held = '1 small step: po (heavy: specs) since 2030-01-08 09:50 UTC; host memory: 6000 MB free, 2048 MB held for it, 6144 MB needed (4096 floor + 2048 for this step)';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:00 UTC waiting to share the host: ${held}`, `REFUSED host memory still short: ${held}`], stderr: [] });
    assert.deepEqual([ledgerOf(kit), kit.files.get(`${SHARED}/id-1.json`)], [[memoryRefused(SPECS_STEP, 6000, 'waiting to share the host', held)], undefined]);
  });

  it('keeps a lone small step waiting while free memory is under the floor plus its own MB, then refuses (T2192)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    const result = await kit.run(SPECS, { steps, memory: new FakeHostMemory(6000) });
    const short = 'host memory: 6000 MB free, 6144 MB needed (4096 floor + 2048 for this step)';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:00 UTC waiting to share the host: ${short}`, `REFUSED host memory still short: ${short}`], stderr: [] });
    assert.deepEqual([steps.ran, ledgerOf(kit), await kit.files.list(SHARED)], [[], [memoryRefused(SPECS_STEP, 6000, 'waiting to share the host', short)], []]);
  });

  it('keeps a heavy step waiting while free memory is under the floor plus delivery.queue.heavyReserveMb, then refuses (T2192)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(5000) });
    const short = 'host memory: 5000 MB free, 6144 MB needed (4096 floor + 2048 for this step)';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`], stderr: [] });
    assert.deepEqual([steps.ran, ledgerOf(kit), kit.files.get(LOCK)], [[], [memoryRefused(BUILD_STEP, 5000, 'waiting for the host lock', short)], undefined]);
  });

  it('names the programs holding the most memory when it refuses after its wait on host memory, printed and recorded (T2209)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(5000).holds(BUSY_HOLDERS) });
    const short = 'host memory: 5000 MB free, 6144 MB needed (4096 floor + 2048 for this step)';
    const reason = `host memory still short: ${short}; ${BUSY_HOLDERS_TEXT}`;
    assert.deepEqual(result.stdout, [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED ${reason}`]);
    assert.deepEqual(ledgerOf(kit), [{ ...memoryRefused(BUILD_STEP, 5000, 'waiting for the host lock', short), reason }]);
  });

  it('records on its start record how long a heavy step waited for host memory, and the free memory when it queued (T2209)', async () => {
    const { kit, steps } = harness();
    steps.ends(0, MINUTE);
    const memory = new FakeHostMemory(ROOMY_FREE_MB).readsFree(5000, 5000, 5000);
    assert.equal((await kit.run(BUILD, { steps, memory })).code, 0);
    const [start] = ledgerOf(kit);
    const short = 3 * FIRST_IN_LINE_POLL_MS;
    assert.deepEqual(start, { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', waits: { memory: short }, queueFreeMb: 5000, startedAt: new Date(Date.parse('2030-01-08T10:00:00Z') + short).toISOString(), endedAt: null, exitCode: null }, 'it waits two short looks of the first in line, then its last look before it takes the lock');
  });

  it('holds for a heavy step its latest runs\' peak with a quarter more when that passes delivery.queue.heavyReserveMb (T2192)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(LEDGER, `${[ranBefore('alpha', 'build api', 2000), ranBefore('alpha', 'build api', 6000), ranBefore('bravo', 'build api', 9000)].join('\n')}\n`);
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(10_000) });
    const short = 'host memory: 10000 MB free, 11596 MB needed (4096 floor + 7500 for this step, learned from 2 runs)';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`], stderr: [] });
  });

  it('holds for a heavy step the median of what the host lost during its runs when that passes their peak (T2209)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(LEDGER, `${[ranBefore('alpha', 'build api', 1000, { startFreeMb: 12_000, lowFreeMb: 4000 }), ranBefore('alpha', 'build api', 1200, { startFreeMb: 12_000, lowFreeMb: 6000 })].join('\n')}\n`);
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(10_000) });
    const short = 'host memory: 10000 MB free, 11096 MB needed (4096 floor + 7000 for this step, learned from 2 runs)';
    assert.deepEqual(result.stdout, [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`]);
  });

  it('falls back to its session\'s runs of the same kind when none has its label, and names the kind (T2209)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(LEDGER, `${ranBefore('alpha', 'T8 build', 6000, { kind: 'build' })}\n`);
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(10_000) });
    const short = 'host memory: 10000 MB free, 11596 MB needed (4096 floor + 7500 for this step, learned from 1 build run)';
    assert.deepEqual(result.stdout, [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`]);
  });

  it('holds for a step the MB it declares with --memory-mb when more than it learned (T2209)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    const declared = ['queue', '--session', 'alpha', '--what', 'build api', '--memory-mb', '9000', '--', 'npm', 'run', 'build'];
    const result = await kit.run(declared, { steps, memory: new FakeHostMemory(10_000) });
    const short = 'host memory: 10000 MB free, 13096 MB needed (4096 floor + 9000 for this step, declared with --memory-mb)';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`], stderr: [] });
    assert.deepEqual(steps.ran, []);
  });

  it('holds delivery.queue.heavyReserveMb for a heavy step whose latest runs\' peak with a quarter more is less (T2192)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(LEDGER, `${ranBefore('alpha', 'build api', 1200)}\n`);
    const result = await kit.run(BUILD, { steps, memory: new FakeHostMemory(5000) });
    const short = 'host memory: 5000 MB free, 6144 MB needed (4096 floor + 2048 for this step)';
    assert.deepEqual(result.stdout, [`2030-01-08 10:00:00 UTC waiting for the host lock: ${short}`, `REFUSED host memory still short: ${short}`]);
  });

  it('makes a step without it wait for the small steps sharing the host with delivery.queue.admission serial, then refuse, leaving no lock', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1, admission: 'serial' }, wait: { pollSeconds: 30 } } });
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    const held = '1 small step: po (heavy: specs) since 2030-01-08 09:50 UTC';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:02 UTC waiting for the host lock: ${held}`, `REFUSED host lock still held by ${held}`], stderr: [] });
    assert.equal(kit.files.get(LOCK), undefined);
  });

  it('runs a step without it beside the small steps sharing the host, as a heavy share, under the default pipeline admission (T2210)', async () => {
    const { kit, steps } = harness();
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    const result = await kit.run(BUILD, { steps, sessionProcesses: otherRuns() });
    const sharing = `2030-01-08 10:00:02 UTC sharing the host as a heavy step: 2048 MB held for it (${ROOMY_FREE_MB} MB free, 0 other heavy steps, 1 small step)`;
    assert.deepEqual(result, { code: 0, stdout: [sharing, '2030-01-08 10:00:02 UTC running: build api (killed after 45m)', 'DONE exit 0'], stderr: [] });
    assert.deepEqual([kit.files.get(LOCK), kit.files.get(`${SHARED}/other.json`)], [undefined, sharedBy()]);
  });
});

describe('teamrig queue --exclusive', () => {
  const EXCLUSIVE = ['queue', '--session', 'alpha', '--what', 'build api', '--exclusive', '--', 'npm', 'run', 'build'];

  it('takes the whole host under the default pipeline admission: the lock file, no share, recorded as not shared (T2210)', async () => {
    const { kit, steps } = harness();
    let whileRunning: unknown[] = [];
    steps.ends(0, 5 * MINUTE).whileRunning(async () => {
      whileRunning = [JSON.parse(kit.files.get(LOCK) ?? '{}'), kit.files.get(`${SHARED}/id-1.json`)];
    });
    const result = await kit.run(EXCLUSIVE, { steps });
    assert.deepEqual(result, { code: 0, stdout: ['2030-01-08 10:00:02 UTC running: build api (killed after 45m)', 'DONE exit 0'], stderr: [] });
    const lock = { token: 'id-1', pid: 4242, session: 'alpha', purpose: 'heavy: build api', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:00:02.000Z', expiresAt: '2030-01-08T12:30:02.000Z' };
    assert.deepEqual(whileRunning, [lock, undefined]);
    assert.equal(kit.files.get(LOCK), undefined, 'the lock is released');
    const start = { type: 'heavy', id: 'id-2', session: 'alpha', what: 'build api', kind: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: ROOMY_FREE_MB, startedAt: '2030-01-08T10:00:02.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(ledgerOf(kit), [start, { ...start, endedAt: '2030-01-08T10:05:02.000Z', exitCode: 0 }]);
  });

  it('asks for the whole host on its ticket and waits for the small steps sharing it to end, then refuses, leaving no lock (T2210)', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await kit.files.append(`${SHARED}/other.json`, sharedBy());
    const requests: unknown[] = [];
    const sleep = async (ms: number): Promise<void> => {
      requests.push(...(await lineRequests(kit.files, LOCK)));
      await kit.clock.sleep(ms);
    };
    const result = await kit.run(EXCLUSIVE, { steps, sessionProcesses: otherRuns(), sleep });
    const held = '1 small step: po (heavy: specs) since 2030-01-08 09:50 UTC';
    assert.deepEqual(result, { code: 2, stdout: [`2030-01-08 10:00:02 UTC waiting for the host lock: ${held}`, `REFUSED host lock still held by ${held}`], stderr: [] });
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(`${SHARED}/other.json`)], [[], undefined, sharedBy()]);
    const request = { kind: 'build', class: 'Improvements', classPct: 15, needMb: 2048, heavy: true, exclusive: true };
    assert.deepEqual([requests.length > 0, requests.filter((seen) => !isDeepStrictEqual(seen, request))], [true, []]);
  });

  it('refuses --exclusive with --small as a usage error, before it waits or records anything (T2210)', async () => {
    const { kit, steps } = harness();
    const result = await kit.run(['queue', '--session', 'alpha', '--what', 'specs', '--small', '--exclusive', '--', 'npm', 'test'], { steps });
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr.join('\n'), /--exclusive takes the whole host and --small shares it: give one of them/);
    assert.deepEqual([steps.ran, kit.files.get(LOCK), kit.files.get(LEDGER)], [[], undefined, undefined]);
  });
});


describe('teamrig queue --pre-push', () => {
  const PRE_PUSH = ['queue', '--session', 'alpha', '--what', 'pre-push checks', '--pre-push', '--', 'npm', 'test'];
  const PASSES = join(GIT_DIR, 'teamrig', 'pre-push');
  const DECLINED = 'REFUSED push declined: its checks waited 3m for the host lock, long enough for its connection to close;';

  it('records the pass of checks run on a clean tree, which the next push of the tree reuses without the lock', async () => {
    const { kit, steps } = harness();
    const trees = new FakeTrees(cleanTree());
    steps.ends(0, MINUTE);
    const ran = [heavyShared('2030-01-08 10:00:02 UTC'), '2030-01-08 10:00:02 UTC running: pre-push checks (killed after 45m)', 'DONE exit 0'];
    assert.deepEqual(await kit.run(PRE_PUSH, { steps, trees }), { code: 0, stdout: ran, stderr: [] });
    assert.equal((await kit.files.list(PASSES)).length, 1);
    await kit.files.write(LOCK, heldBy());
    assert.deepEqual(await kit.run(PRE_PUSH, { steps, trees, sessionProcesses: otherRuns() }), {
      code: 0,
      stdout: ['2030-01-08 10:01:02 UTC pre-push checks passed on this tree (c0ffee1) at 2030-01-08 10:01 UTC: not run again', 'DONE exit 0'],
      stderr: [],
    });
    assert.deepEqual([steps.ran.length, ledgerOf(kit).length, kit.files.get(LOCK)], [1, 2, heldBy()], 'nothing ran or was recorded, and the lock stayed with its holder');
    assert.deepEqual(trees.looks, [APP, APP, APP], 'the tree before and after the checks, then before the next push');
  });

  it('reuses a pass from the queue cutoff on, since it runs nothing', async () => {
    const { kit, steps } = harness({ ...TEAM, delivery: { schedule: { queueCutoffUtc: '09:30' } } });
    await recordPass(kit.files, cleanTree(), 'npm test', 'pre-push checks', Date.parse('2030-01-08T09:00:00Z'));
    const result = await kit.run(PRE_PUSH, { steps, trees: new FakeTrees(cleanTree()) });
    assert.deepEqual([result.code, result.stdout.at(-1), steps.ran], [0, 'DONE exit 0', []]);
  });

  it('runs checks with another command line again on the same tree', async () => {
    const { kit, steps } = harness();
    await recordPass(kit.files, cleanTree(), 'npm test', 'pre-push checks', Date.parse('2030-01-08T09:00:00Z'));
    const result = await kit.run([...PRE_PUSH.slice(0, -1), 'run', 'lint'], { steps, trees: new FakeTrees(cleanTree()) });
    assert.deepEqual([result.code, steps.ran.map((request) => request.command)], [0, ['npm run lint']]);
  });

  it('declines the push when its checks waited over a minute for the lock, and records their pass for the next push', async () => {
    const { kit, steps } = harness();
    const trees = new FakeTrees(cleanTree());
    steps.ends(0, MINUTE);
    await kit.files.write(LOCK, heldBy('2030-01-08T10:03:00.000Z'));
    const result = await kit.run(PRE_PUSH, { steps, trees, sessionProcesses: otherRuns() });
    assert.deepEqual(result, {
      code: 2,
      stdout: [
        '2030-01-08 10:00:00 UTC waiting for the host lock: po (heavy: build) since 2030-01-08 09:50 UTC',
        heavyShared('2030-01-08 10:03:02 UTC'),
        '2030-01-08 10:03:02 UTC running: pre-push checks (killed after 45m)',
        'DONE exit 0',
        `${DECLINED} push again: it reuses this pass`,
      ],
      stderr: [],
    });
    assert.deepEqual([kit.files.get(LOCK), await kit.files.list(SHARED)], [heldBy('2030-01-08T10:03:00.000Z'), []], 'its share is released; the expired lock is left for the next step that takes the lock');
    const again = await kit.run(PRE_PUSH, { steps, trees });
    assert.deepEqual([again.code, again.stdout.at(-1), steps.ran.length], [0, 'DONE exit 0', 1]);
  });

  it("lets the push go after a wait of a minute, the memory gate's reads counted in it", async () => {
    const { kit, steps } = harness();
    // The lock frees at 10:00:58 and the gate's reads take 2 s more: the push's connection is open through both.
    await kit.files.write(LOCK, heldBy('2030-01-08T10:00:58.000Z'));
    const result = await kit.run(PRE_PUSH, { steps, trees: new FakeTrees(cleanTree()), sessionProcesses: otherRuns() });
    assert.deepEqual([result.code, result.stdout.at(-1)], [0, 'DONE exit 0']);
  });

  for (const { label, trees, during, reason } of [
    { label: 'a tree with uncommitted changes', trees: new FakeTrees({ kind: 'changed' }), during: undefined, reason: 'the tree has uncommitted changes' },
    { label: 'a folder with no git commit', trees: new FakeTrees(), during: undefined, reason: 'this folder has no git commit to record it for' },
    { label: 'a tree that changed while the checks ran', trees: new FakeTrees(cleanTree()), during: cleanTree('ffff0000'), reason: 'the tree changed while they ran' },
  ]) {
    it(`records no pass for ${label}, and says so when it declines the push`, async () => {
      const { kit, steps } = harness();
      steps.whileRunning(async () => {
        trees.state = during ?? trees.state;
      });
      await kit.files.write(LOCK, heldBy('2030-01-08T10:03:00.000Z'));
      const result = await kit.run(PRE_PUSH, { steps, trees, sessionProcesses: otherRuns() });
      assert.deepEqual([result.code, result.stdout.at(-1)], [2, `${DECLINED} no pass was recorded, as ${reason}: commit, then push again`]);
      assert.deepEqual(await kit.files.list(PASSES), []);
    });
  }

  it('records no pass for checks that failed, which run again on the next push', async () => {
    const { kit, steps } = harness();
    const trees = new FakeTrees(cleanTree());
    steps.ends(1);
    await kit.files.write(LOCK, heldBy('2030-01-08T10:03:00.000Z'));
    const result = await kit.run(PRE_PUSH, { steps, trees, sessionProcesses: otherRuns() });
    assert.deepEqual([result.code, result.stdout.at(-1)], [1, 'FAILED exit 1']);
    assert.deepEqual(await kit.files.list(PASSES), []);
    await kit.run(PRE_PUSH, { steps, trees });
    assert.equal(steps.ran.length, 2);
  });

  it("records the pass of checks run under a parent's lock", async () => {
    const { kit, steps } = harness();
    await kit.files.write(LOCK, heldBy());
    const result = await kit.run(PRE_PUSH, { steps, trees: new FakeTrees(cleanTree()), sessionProcesses: otherRuns(), env: { TEAMRIG_HOST_LOCK: 'other' } });
    assert.deepEqual([result.code, (await kit.files.list(PASSES)).length], [0, 1]);
  });

  it('reads no tree and records no pass without --pre-push', async () => {
    const { kit, steps } = harness();
    const trees = new FakeTrees(cleanTree());
    assert.equal((await kit.run(BUILD, { steps, trees })).code, 0);
    assert.deepEqual([trees.looks, await kit.files.list(PASSES)], [[], []]);
  });
});
