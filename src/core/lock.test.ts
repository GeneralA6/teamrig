import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { FaultyFiles } from '../testing/faulty-files.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { Files } from './files.ts';
import { FileLock, LockBusyError, type LockTimings, realSleep, type Sleep, systemClock } from './lock.ts';

const TIMINGS: LockTimings = { ttlMs: 30_000, pollMs: 50, waitMs: 1_000 };
const PATH = '/state/events.lock';
const GUARD = `${PATH}.takeover`;
/** The processes that run: this one (42) and another holder (7); 9 is gone. */
const RUNNING = new Set([42, 7]);

function lockWith(files: Files, clock: FakeClock, options: { readonly pid?: number; readonly sleep?: Sleep } = {}): FileLock {
  const { pid = 42, sleep = clock.sleep } = options;
  return new FileLock(PATH, TIMINGS, { files, clock, sleep, pid, alive: (other) => RUNNING.has(other), newId: () => `take-${pid}` });
}

function lockText(pid: number, at: number): string {
  return JSON.stringify({ pid, at, id: `take-${pid}` });
}

/** A promise and the call that settles it. */
function signal(): { readonly promise: Promise<void>; readonly settle: () => void } {
  let settle = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * Files whose first read of `path` reads at once, tells `read`, and answers only once `until` settles: a waiter that
 * stalled after reading a lock.
 */
class LateFirstRead extends FaultyFiles {
  private readonly path: string;
  private readonly onRead: () => void;
  private pending: Promise<void> | undefined;

  constructor(inner: Files, path: string, read: () => void, until: Promise<void>) {
    super(inner);
    this.path = path;
    this.onRead = read;
    this.pending = until;
  }

  override async read(path: string): Promise<string | undefined> {
    const text = await super.read(path);
    const until = path === this.path ? this.pending : undefined;
    if (until !== undefined) {
      this.pending = undefined;
      this.onRead();
      await until;
    }
    return text;
  }
}

/** Files whose first removal of `path` starts only once `until` settles: a waiter slower to remove than another to read. */
class LateFirstRemove extends FaultyFiles {
  private readonly path: string;
  private pending: Promise<void> | undefined;

  constructor(inner: Files, path: string, until: Promise<void>) {
    super(inner);
    this.path = path;
    this.pending = until;
  }

  override async remove(path: string): Promise<boolean> {
    const until = path === this.path ? this.pending : undefined;
    if (until !== undefined) {
      this.pending = undefined;
      await until;
    }
    return super.remove(path);
  }
}

describe('FileLock', () => {
  it('holds the lock file while the task runs and removes it after', async () => {
    const files = new MemoryFiles();
    const clock = new FakeClock(1_000);
    const result = await lockWith(files, clock).run(async () => {
      assert.deepEqual(JSON.parse(files.get(PATH) ?? ''), { pid: 42, at: 1_000, id: 'take-42' });
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(files.get(PATH), undefined);
  });

  it('leaves a lock another process took over meanwhile (T1584)', async () => {
    const files = new MemoryFiles();
    const theirs = lockText(7, 1_000);
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
    const files = new MemoryFiles({ [PATH]: lockText(7, 10_000) });
    await assert.rejects(lockWith(files, clock).run(async () => 'never'), LockBusyError);
    assert.equal(clock.sleeps.length, TIMINGS.waitMs / TIMINGS.pollMs);
    assert.equal(files.get(PATH), lockText(7, 10_000), 'the live holder keeps its lock');
  });

  it('takes over at once a lock whose process is gone (T1584)', async () => {
    const clock = new FakeClock(10_000);
    const files = new MemoryFiles({ [PATH]: lockText(9, 10_000) });
    assert.equal(await lockWith(files, clock).run(async () => 'ran'), 'ran');
    assert.deepEqual(clock.sleeps, []);
    assert.equal(files.get(GUARD), undefined, 'the takeover guard is released');
  });

  it('takes over a lock older than the TTL even while a process with its pid runs, which may be another by then', async () => {
    const clock = new FakeClock(100_000);
    const files = new MemoryFiles({ [PATH]: lockText(7, 100_000 - TIMINGS.ttlMs - 1) });
    assert.equal(await lockWith(files, clock).run(async () => 'ran'), 'ran');
    assert.deepEqual(clock.sleeps, []);
  });

  it('takes over an unreadable lock file', async () => {
    const files = new MemoryFiles({ [PATH]: 'garbage' });
    assert.equal(await lockWith(files, new FakeClock()).run(async () => 'ran'), 'ran');
  });

  it('acquires once the holder releases', async () => {
    const clock = new FakeClock(0);
    const files = new MemoryFiles({ [PATH]: lockText(7, 0) });
    let polls = 0;
    const sleep: Sleep = async (ms) => {
      polls += 1;
      if (polls === 3) {
        await files.remove(PATH);
      }
      await clock.sleep(ms);
    };
    assert.equal(await lockWith(files, clock, { sleep }).run(async () => 'ran'), 'ran');
    assert.equal(polls, 3);
  });

  it('lets one of two waiters that judged a stale lock take it over, and the other waits for it (T1584)', async () => {
    const clock = new FakeClock(0);
    const files = new MemoryFiles({ [PATH]: lockText(9, -TIMINGS.ttlMs - 1) });
    const bRead = signal();
    const aHolds = signal();
    const bMoved = signal();
    let inside = 0;
    let most = 0;
    const enter = async (then: Promise<void>): Promise<void> => {
      inside += 1;
      most = Math.max(most, inside);
      await then;
      inside -= 1;
    };
    // Both read the stale lock before A removes it; B goes on only once A took it over and holds it.
    const aFiles = new LateFirstRemove(files, PATH, bRead.promise);
    const bFiles = new LateFirstRead(files, PATH, bRead.settle, aHolds.promise);
    const bSleep: Sleep = async (ms) => {
      bMoved.settle();
      await clock.sleep(ms);
    };
    const a = lockWith(aFiles, clock).run(async () => {
      aHolds.settle();
      await enter(bMoved.promise);
    });
    const b = lockWith(bFiles, clock, { pid: 7, sleep: bSleep }).run(async () => {
      bMoved.settle();
      await enter(Promise.resolve());
    });
    await Promise.all([a, b]);
    assert.equal(most, 1, 'never two holders at once');
    assert.equal(files.get(PATH), undefined);
    assert.equal(files.get(GUARD), undefined);
  });

  it('clears the takeover guard a waiter that died mid-takeover left, then takes the stale lock (T1584)', async () => {
    const clock = new FakeClock(0);
    const files = new MemoryFiles({ [PATH]: lockText(9, 0), [GUARD]: lockText(9, 0) });
    assert.equal(await lockWith(files, clock).run(async () => 'ran'), 'ran');
    assert.deepEqual(clock.sleeps, [TIMINGS.pollMs], 'the next try after clearing the guard takes the lock');
    assert.equal(files.get(GUARD), undefined);
  });

  it('waits while a live waiter takes over a stale lock (T1584)', async () => {
    const clock = new FakeClock(0);
    const files = new MemoryFiles({ [PATH]: lockText(9, 0), [GUARD]: lockText(7, 0) });
    const guardAtPoll: (string | undefined)[] = [];
    const sleep: Sleep = async (ms) => {
      guardAtPoll.push(files.get(GUARD));
      await files.remove(PATH);
      await files.remove(GUARD);
      await clock.sleep(ms);
    };
    assert.equal(await lockWith(files, clock, { sleep }).run(async () => 'ran'), 'ran');
    assert.deepEqual(guardAtPoll, [lockText(7, 0)], 'the live waiter keeps its guard');
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
