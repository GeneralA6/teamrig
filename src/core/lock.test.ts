import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { FileLock, LockBusyError, type LockTimings, realSleep, systemClock } from './lock.ts';

const TIMINGS: LockTimings = { ttlMs: 30_000, pollMs: 50, waitMs: 1_000 };
const PATH = '/state/events.lock';

function lockWith(files: MemoryFiles, clock: FakeClock): FileLock {
  return new FileLock(PATH, TIMINGS, { files, clock, sleep: clock.sleep, pid: 42, newId: () => 'take-1' });
}

describe('FileLock', () => {
  it('holds the lock file while the task runs and removes it after', async () => {
    const files = new MemoryFiles();
    const clock = new FakeClock(1_000);
    const result = await lockWith(files, clock).run(async () => {
      assert.deepEqual(JSON.parse(files.get(PATH) ?? ''), { pid: 42, at: 1_000, id: 'take-1' });
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(files.get(PATH), undefined);
  });

  it('leaves a lock another process took over meanwhile (T1584)', async () => {
    const files = new MemoryFiles();
    const theirs = JSON.stringify({ pid: 7, at: 1_000, id: 'take-7' });
    await lockWith(files, new FakeClock(1_000)).run(async () => {
      await files.write(PATH, theirs);
    });
    assert.equal(files.get(PATH), theirs, 'the release removes only its own taking');
  });

  it('releases the lock when the task throws', async () => {
    const files = new MemoryFiles();
    await assert.rejects(
      lockWith(files, new FakeClock()).run(async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(files.get(PATH), undefined);
  });

  it('gives up with LockBusyError after the wait when a live holder keeps the lock', async () => {
    const clock = new FakeClock(10_000);
    const files = new MemoryFiles({ [PATH]: JSON.stringify({ pid: 7, at: 10_000 }) });
    await assert.rejects(lockWith(files, clock).run(async () => 'never'), LockBusyError);
    assert.equal(clock.sleeps.length, TIMINGS.waitMs / TIMINGS.pollMs);
    assert.ok(files.get(PATH)?.includes('"pid":7'), 'the live holder keeps its lock');
  });

  it('takes over a lock older than the TTL', async () => {
    const clock = new FakeClock(100_000);
    const files = new MemoryFiles({ [PATH]: JSON.stringify({ pid: 7, at: 100_000 - TIMINGS.ttlMs - 1 }) });
    assert.equal(await lockWith(files, clock).run(async () => 'ran'), 'ran');
    assert.deepEqual(clock.sleeps, []);
  });

  it('takes over an unreadable lock file', async () => {
    const files = new MemoryFiles({ [PATH]: 'garbage' });
    assert.equal(await lockWith(files, new FakeClock()).run(async () => 'ran'), 'ran');
  });

  it('acquires once the holder releases', async () => {
    const clock = new FakeClock(0);
    const files = new MemoryFiles({ [PATH]: JSON.stringify({ pid: 7, at: 0 }) });
    const release = clock.sleep;
    let polls = 0;
    const lock = new FileLock(PATH, TIMINGS, {
      files,
      clock,
      pid: 42,
      newId: () => 'take-1',
      sleep: async (ms) => {
        polls += 1;
        if (polls === 3) {
          await files.remove(PATH);
        }
        await release(ms);
      },
    });
    assert.equal(await lock.run(async () => 'ran'), 'ran');
    assert.equal(polls, 3);
  });
});

// The real clock and sleep run in other tests only when two processes contend for a lock, which
// depends on the runner's speed; mocked timers cover them on every OS.
describe('systemClock and realSleep', () => {
  it('read the system time and wait on a real timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000 });
    assert.equal(systemClock.now(), 5_000);
    let woke = false;
    const slept = realSleep(50).then(() => {
      woke = true;
    });
    t.mock.timers.tick(49);
    await Promise.resolve();
    assert.equal(woke, false);
    t.mock.timers.tick(1);
    await slept;
    assert.equal(woke, true);
  });
});
