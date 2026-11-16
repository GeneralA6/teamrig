import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { HostLockInfo, HostShare } from '../delivery/host-lock.ts';
import { KIT_VERSION } from '../core/version.ts';
import { CliHarness, CLI_PID, KIT, TEAM } from '../testing/cli-harness.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { EXIT } from './runtime.ts';

const LOCK = join(KIT, 'host.lock');
const SHARED = `${LOCK}.shared`;
const AWAY = `${LOCK}.away`;
const STEP = 9001;

/** The queued step's process and this one run, so the step's share is live. */
function running(): FakeSessionProcesses {
  return new FakeSessionProcesses()
    .add({ pid: CLI_PID, parentPid: STEP, name: 'node', commandLine: 'node cli.ts step-away' })
    .add({ pid: STEP, parentPid: 1, name: 'node', commandLine: 'node cli.ts queue' });
}

/** alpha's merge, sharing the host as a heavy step since 09:50 with 4096 MB held, run by `STEP`. */
const MERGE: HostShare = {
  id: 'm1',
  pid: STEP,
  session: 'alpha',
  purpose: 'heavy: merge api',
  kit: KIT_VERSION,
  acquiredAt: '2030-01-08T09:50:00.000Z',
  expiresAt: '2030-01-08T12:20:00.000Z',
  reserveMb: 4096,
  heavy: true,
};

const UNDER = { TEAMRIG_HOST_LOCK: 'm1' };

describe('teamrig step-away and step-back', () => {
  it("sets the queued step's host share aside, then takes it back in turn under its id and process", async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(join(SHARED, 'm1.json'), JSON.stringify(MERGE));
    const away = await kit.run(['step-away'], { sessionProcesses: running(), env: UNDER });
    assert.deepEqual(away, { code: 0, stdout: ['AWAY heavy: merge api: its host share (4096 MB) goes to the next step in line until teamrig step-back takes it back in turn'], stderr: [] });
    assert.deepEqual([await kit.files.list(SHARED), await kit.files.list(AWAY)], [[], ['m1.json']]);
    const back = await kit.run(['step-back'], { sessionProcesses: running(), env: UNDER });
    assert.deepEqual([back.code, back.stdout.at(-1), await kit.files.list(SHARED), await kit.files.list(AWAY)], [0, 'BACK heavy: merge api: its host share is taken back', ['m1.json'], []]);
    const share = kit.files.get(join(SHARED, 'm1.json'));
    assert.ok(share !== undefined);
    const parsed: unknown = JSON.parse(share);
    assert.ok(typeof parsed === 'object' && parsed !== null && 'id' in parsed && 'pid' in parsed);
    assert.deepEqual([parsed.id, parsed.pid], ['m1', STEP]);
  });

  it('keeps the whole host for a step holding the lock file, and says when nothing is held or set aside', async () => {
    const kit = new CliHarness(TEAM);
    const held: HostLockInfo = { id: 'm1', pid: STEP, session: 'alpha', purpose: 'merge api', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z' };
    await kit.files.write(LOCK, JSON.stringify(held));
    const kept = await kit.run(['step-away'], { sessionProcesses: running(), env: UNDER });
    assert.deepEqual(kept, { code: 1, stdout: ['KEPT alpha (merge api) since 2030-01-08 09:50 UTC: it holds the whole host (the lock file), which it keeps'], stderr: [] });
    assert.equal(kit.files.get(LOCK), JSON.stringify(held));
    const none = await kit.run(['step-away'], { sessionProcesses: running(), env: { TEAMRIG_HOST_LOCK: 'gone' } });
    assert.deepEqual([none.code, none.stdout], [1, ['NONE no live host share or lock has the id gone: nothing set aside']]);
    const back = await kit.run(['step-back'], { sessionProcesses: running(), env: UNDER });
    assert.deepEqual([back.code, back.stdout], [0, ['NONE no host share of m1 is set aside: the step holds what it held']]);
  });

  it('keeps the share an older teamrig took, whose release would leave it set aside behind (T3409)', async () => {
    const kit = new CliHarness(TEAM);
    const older: HostShare = { ...MERGE, kit: '0.447.0' };
    await kit.files.write(join(SHARED, 'm1.json'), JSON.stringify(older));
    const kept = await kit.run(['step-away'], { sessionProcesses: running(), env: UNDER });
    assert.deepEqual(kept, { code: 1, stdout: ['KEPT heavy: merge api: its host share was taken by teamrig 0.447.0, whose release would leave a share set aside behind, so the step keeps it'], stderr: [] });
    assert.deepEqual([await kit.files.list(SHARED), await kit.files.list(AWAY)], [['m1.json'], []]);
  });

  it('waits in line to take the share back, giving up when its wait runs out and stopping when withdrawn, the share kept aside', async () => {
    const HOLDER = 7001;
    const held: HostLockInfo = { id: 'h1', pid: HOLDER, session: 'po', purpose: 'heavy: build', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z' };
    const busy = (): FakeSessionProcesses => running().add({ pid: HOLDER, parentPid: 1, name: 'node', commandLine: 'node cli.ts queue' });
    const setUp = async (kit: CliHarness): Promise<void> => {
      await kit.files.write(LOCK, JSON.stringify(held));
      await kit.files.write(join(AWAY, 'm1.json'), JSON.stringify(MERGE));
    };

    const timed = new CliHarness({ ...TEAM, delivery: { queue: { waitMinutes: 1 }, wait: { pollSeconds: 30 } } });
    await setUp(timed);
    const gaveUp = await timed.run(['step-back'], { sessionProcesses: busy(), env: UNDER });
    assert.equal(gaveUp.code, 1);
    assert.match(gaveUp.stdout[0] ?? '', /waiting to take back its host share: po \(heavy: build\)/);
    assert.match(gaveUp.stdout.at(-1) ?? '', /^GAVE UP host lock still held by po \(heavy: build\)/);
    assert.deepEqual(await timed.files.list(AWAY), ['m1.json'], 'the share stays aside for a later step-back');

    const withdrawn = new CliHarness(TEAM);
    await setUp(withdrawn);
    const queue = `${LOCK}.queue`;
    const sleep = async (ms: number): Promise<void> => {
      await withdrawn.clock.sleep(ms);
      for (const name of await withdrawn.files.list(queue)) {
        await withdrawn.files.remove(join(queue, name));
      }
    };
    const stopped = await withdrawn.run(['step-back'], { sessionProcesses: busy(), env: UNDER, sleep });
    assert.deepEqual([stopped.code, stopped.stdout.at(-1)], [1, "WITHDRAWN from the host lock's line (teamrig withdraw): its host share stays set aside"]);
    assert.deepEqual(await withdrawn.files.list(AWAY), ['m1.json']);
  });

  it('is refused outside a queued step', async () => {
    const kit = new CliHarness(TEAM);
    for (const command of ['step-away', 'step-back']) {
      const result = await kit.run([command], { sessionProcesses: running() });
      assert.equal(result.code, EXIT.usage, command);
      assert.match(result.stderr.join('\n'), new RegExp(`${command} runs only inside a queued step`));
    }
  });
});
