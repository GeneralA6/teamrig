import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sleep } from '../core/lock.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { FIRST_IN_LINE_POLL_MS, HostLock, holderText, waitText, type HostLockInfo, type LockWait, type LockWaiter } from './host-lock.ts';

const PATH = '/kit/host.lock';
const QUEUE = `${PATH}.queue`;
const TTL_MS = 150 * 60_000;
const ME = 4242;
const OTHER = 9001;

/** A lock another step holds: taken at 09:50, lasting to 12:20, by a process that runs. */
function heldBy(overrides: Partial<HostLockInfo> = {}): string {
  return JSON.stringify({
    token: 'other',
    pid: OTHER,
    session: 'po',
    purpose: 'heavy: build',
    acquiredAt: '2030-01-08T09:50:00.000Z',
    expiresAt: '2030-01-08T12:20:00.000Z',
    ...overrides,
  });
}

interface World {
  readonly files: MemoryFiles;
  readonly clock: FakeClock;
  readonly running: Set<number>;
  readonly lock: HostLock;
}

/** The host lock over files in memory at 10:00, with this process and `OTHER` running; `sleep` default the clock's. */
function world(initial: Readonly<Record<string, string>> = {}, sleep?: (clock: FakeClock, files: MemoryFiles) => Sleep): World {
  const files = new MemoryFiles(initial);
  const clock = new FakeClock('2030-01-08T10:00:00Z');
  const running = new Set([ME, OTHER]);
  let ids = 0;
  const lock = new HostLock(PATH, TTL_MS, {
    files,
    clock,
    sleep: sleep === undefined ? clock.sleep : sleep(clock, files),
    pid: ME,
    alive: (pid) => running.has(pid),
    newId: () => {
      ids += 1;
      return `t${ids}`;
    },
  });
  return { files, clock, running, lock };
}

/** A waiter in the line: bravo, run by `OTHER`, its wait lasting to 11:00. */
function waiterOf(arrivedAt: string, overrides: Partial<LockWaiter> = {}): LockWaiter {
  return { token: 'bravo', pid: OTHER, session: 'bravo', purpose: 'heavy: lint', arrivedAt, expiresAt: '2030-01-08T11:00:00.000Z', ...overrides };
}

/** A waiter's ticket in the line, `[path, text]`. */
function ticket(waiter: LockWaiter): [string, string] {
  return [`${QUEUE}/${String(Date.parse(waiter.arrivedAt)).padStart(15, '0')}-${waiter.token}.json`, JSON.stringify(waiter)];
}

/** The tickets in the line, by name. */
async function lineOf(files: MemoryFiles): Promise<string[]> {
  return files.list(QUEUE);
}

function fileOf(files: MemoryFiles): unknown {
  const text = files.get(PATH);
  return text === undefined ? undefined : JSON.parse(text);
}

describe('HostLock.tryTake', () => {
  it('takes a free lock, writing the file a team coordinator writes too', async () => {
    const { files, lock } = world();
    const taking = await lock.tryTake('alpha', 'heavy: build api');
    const expected = { token: 't1', pid: ME, session: 'alpha', purpose: 'heavy: build api', acquiredAt: '2030-01-08T10:00:00.000Z', expiresAt: '2030-01-08T12:30:00.000Z' };
    assert.deepEqual(taking, { kind: 'taken', lock: expected });
    assert.deepEqual(fileOf(files), expected);
  });

  it('names the holder of a live lock and leaves its file', async () => {
    const { files, lock } = world({ [PATH]: heldBy() });
    const taking = await lock.tryTake('alpha', 'heavy: test');
    assert.equal(taking.kind, 'busy');
    assert.equal(taking.kind === 'busy' ? holderText(taking.holder) : '', 'po (heavy: build) since 2030-01-08 09:50');
    assert.equal(files.get(PATH), heldBy());
  });

  it('takes over a lock that has expired', async () => {
    const { files, lock } = world({ [PATH]: heldBy({ expiresAt: '2030-01-08T10:00:00.000Z' }) });
    const taking = await lock.tryTake('alpha', 'heavy: test');
    assert.equal(taking.kind, 'taken');
    assert.deepEqual(fileOf(files), taking.kind === 'taken' ? taking.lock : undefined);
  });

  it('takes over a lock whose process is gone', async () => {
    const { files, running, lock } = world({ [PATH]: heldBy() });
    running.delete(OTHER);
    const taking = await lock.tryTake('alpha', 'heavy: test');
    assert.equal(taking.kind, 'taken');
    assert.equal(taking.kind === 'taken' ? taking.lock.session : '', 'alpha');
    assert.deepEqual(fileOf(files), taking.kind === 'taken' ? taking.lock : undefined);
  });

  it('reads extra fields as the same lock', async () => {
    const { lock } = world({ [PATH]: JSON.stringify({ ...JSON.parse(heldBy()), host: 'box' }) });
    const taking = await lock.tryTake('alpha', 'heavy: test');
    assert.equal(taking.kind === 'busy' && taking.holder.kind === 'held' ? taking.holder.info.token : '', 'other');
  });

  for (const [label, text] of [
    ['an empty file', ''],
    ['half a file', '{"token":"other","pid":90'],
    ['a time that is not one', heldBy({ expiresAt: 'soon' })],
  ] as const) {
    it(`leaves ${label} to its writer and names no holder`, async () => {
      const { files, lock } = world({ [PATH]: text });
      const taking = await lock.tryTake('alpha', 'heavy: test');
      assert.deepEqual(taking, { kind: 'busy', holder: { kind: 'unknown' } });
      assert.equal(holderText({ kind: 'unknown' }), 'a writer that has not finished writing');
      assert.equal(files.get(PATH), text);
    });
  }
});

describe('HostLock.acquire', () => {
  it('takes a free lock at once, telling no one it waited and leaving no ticket', async () => {
    const { clock, files, lock } = world();
    const told: LockWait[] = [];
    const taking = await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, (holder) => told.push(holder));
    assert.equal(taking.kind, 'taken');
    assert.deepEqual([told, clock.sleeps, await lineOf(files)], [[], [], []]);
  });

  it('looks again every 2 seconds while first in line until the holder releases, telling of it once', async () => {
    let sleeps = 0;
    const { clock, files, lock } = world({ [PATH]: heldBy() }, (time, store) => async (ms) => {
      await time.sleep(ms);
      sleeps += 1;
      if (sleeps === 2) {
        await store.remove(PATH);
      }
    });
    const told: string[] = [];
    const taking = await lock.acquire('alpha', 'heavy: test', 60 * 60_000, 30_000, (holder) => told.push(holderText(holder)));
    assert.equal(taking.kind, 'taken');
    assert.deepEqual(told, ['po (heavy: build) since 2030-01-08 09:50']);
    assert.deepEqual(clock.sleeps, [FIRST_IN_LINE_POLL_MS, FIRST_IN_LINE_POLL_MS]);
    assert.equal(JSON.parse(files.get(PATH) ?? '{}').session, 'alpha');
  });

  it('tells of each new holder', async () => {
    const { lock } = world({ [PATH]: heldBy() }, (time, store) => async (ms) => {
      await time.sleep(ms);
      await store.write(PATH, heldBy({ token: 'third', session: 'bravo' }));
    });
    const told: string[] = [];
    await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, (holder) => told.push(holderText(holder)));
    assert.deepEqual(told, ['po (heavy: build) since 2030-01-08 09:50', 'bravo (heavy: build) since 2030-01-08 09:50']);
  });

  it('gives up at the deadline, never sleeping past it, names the holder and leaves the line', async () => {
    const { clock, files, lock } = world({ [PATH]: heldBy() });
    const taking = await lock.acquire('alpha', 'heavy: test', 5_000, 30_000, () => undefined);
    assert.equal(taking.kind === 'busy' && taking.holder.kind === 'held' ? taking.holder.info.session : '', 'po');
    assert.deepEqual(clock.sleeps, [2_000, 2_000, 1_000]);
    assert.equal(files.get(PATH), heldBy());
    assert.deepEqual(await lineOf(files), []);
  });

  it('tries once when it may not wait', async () => {
    const { clock, lock } = world({ [PATH]: heldBy() });
    const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined);
    assert.equal(taking.kind, 'busy');
    assert.deepEqual(clock.sleeps, []);
  });

  it('removes a file it cannot read once it has seen it so for 10 seconds', async () => {
    const { clock, files, lock } = world({ [PATH]: '{"tok' });
    const told: string[] = [];
    const taking = await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, (holder) => told.push(holderText(holder)));
    assert.equal(taking.kind, 'taken');
    assert.deepEqual(told, ['a writer that has not finished writing']);
    assert.deepEqual(clock.sleeps, Array.from({ length: HostLock.UNREADABLE_GRACE_MS / FIRST_IN_LINE_POLL_MS }, () => FIRST_IN_LINE_POLL_MS));
    assert.equal(JSON.parse(files.get(PATH) ?? '{}').session, 'alpha');
  });

  it('keeps a file its writer finished meanwhile, counting the 10 seconds again for a new unreadable one', async () => {
    let sleeps = 0;
    const { files, lock } = world({ [PATH]: '{"tok' }, (time, store) => async (ms) => {
      await time.sleep(ms);
      sleeps += 1;
      if (sleeps === 1) {
        await store.write(PATH, heldBy());
      }
    });
    const taking = await lock.acquire('alpha', 'heavy: test', 60_000, 5_000, () => undefined);
    assert.equal(taking.kind, 'busy');
    assert.equal(files.get(PATH), heldBy());
  });
});

describe('HostLock.acquire in arrival order', () => {
  it('writes its ticket while it waits: named by its arrival, with its process and deadline', async () => {
    const seen: string[] = [];
    const { files, lock } = world({ [PATH]: heldBy() }, (time, store) => async (ms) => {
      for (const name of await store.list(QUEUE)) {
        seen.push(`${name} ${store.get(`${QUEUE}/${name}`) ?? ''}`);
      }
      await time.sleep(ms);
    });
    await lock.acquire('alpha', 'heavy: test', 2_000, 30_000, () => undefined);
    const mine = waiterOf('2030-01-08T10:00:00.000Z', { token: 't1', pid: ME, session: 'alpha', purpose: 'heavy: test', expiresAt: '2030-01-08T10:00:02.000Z' });
    const [path, text] = ticket(mine);
    assert.deepEqual(seen, [`${path.slice(QUEUE.length + 1)} ${text}`]);
    assert.deepEqual(await lineOf(files), [], 'it left the line');
  });

  it('leaves a released lock to the waiter that arrived first, telling of it, then takes it in turn', async () => {
    const [early, text] = ticket(waiterOf('2030-01-08T09:59:00.000Z'));
    let sleeps = 0;
    const { clock, files, lock } = world({ [PATH]: heldBy(), [early]: text }, (time, store) => async (ms) => {
      await time.sleep(ms);
      sleeps += 1;
      if (sleeps === 1) {
        await store.remove(PATH);
      } else if (sleeps === 2) {
        await store.write(PATH, heldBy({ token: 'bravo-lock', session: 'bravo' }));
        await store.remove(early);
      } else {
        await store.remove(PATH);
      }
    });
    const told: string[] = [];
    const taking = await lock.acquire('alpha', 'heavy: test', 60 * 60_000, 30_000, (holder, ahead) => told.push(waitText(holder, ahead)));
    assert.equal(taking.kind, 'taken');
    assert.deepEqual(told, [
      'po (heavy: build) since 2030-01-08 09:50; 1 ahead in line',
      'bravo (heavy: lint), first in line since 2030-01-08 09:59; 1 ahead in line',
      'bravo (heavy: build) since 2030-01-08 09:50',
    ]);
    assert.deepEqual(clock.sleeps, [30_000, 30_000, FIRST_IN_LINE_POLL_MS], 'behind a waiter it looks every poll, first in line every 2 s');
    assert.deepEqual([fileOf(files), taking.kind === 'taken' ? taking.lock.token : ''], [
      { token: 't1', pid: ME, session: 'alpha', purpose: 'heavy: test', acquiredAt: '2030-01-08T10:01:02.000Z', expiresAt: '2030-01-08T12:31:02.000Z' },
      't1',
    ], "the lock carries its ticket's token: one step, one token, from joining the line to releasing");
    assert.deepEqual(await lineOf(files), []);
  });

  it('never takes a free lock while an earlier live waiter is in line, and leaves that ticket', async () => {
    const [early, text] = ticket(waiterOf('2030-01-08T09:59:00.000Z'));
    const { files, lock } = world({ [early]: text });
    const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined);
    assert.equal(taking.kind === 'busy' && taking.holder.kind === 'queued' ? taking.holder.first.session : '', 'bravo');
    assert.deepEqual([files.get(PATH), files.get(early), await lineOf(files)], [undefined, text, [early.slice(QUEUE.length + 1)]]);
  });

  it('removes the ticket of a waiter whose process is gone, whose wait ran out or that it cannot read', async () => {
    const gone = ticket(waiterOf('2030-01-08T09:57:00.000Z', { token: 'gone', pid: 7 }));
    const late = ticket(waiterOf('2030-01-08T09:58:00.000Z', { token: 'late', expiresAt: '2030-01-08T10:00:00.000Z' }));
    const [damaged] = ticket(waiterOf('2030-01-08T09:59:00.000Z', { token: 'damaged' }));
    const sibling = `${damaged}.4242.1.tmp`;
    const { clock, files, lock } = world(Object.fromEntries([gone, late, [damaged, '{"tok'], [sibling, 'partial']]));
    const taking = await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined);
    assert.equal(taking.kind, 'taken');
    assert.deepEqual(clock.sleeps, []);
    assert.deepEqual(await lineOf(files), [sibling.slice(QUEUE.length + 1)], "a writer's temporary sibling is no ticket");
  });

  it('goes ahead of a waiter that arrived after it', async () => {
    const [later, text] = ticket(waiterOf('2030-01-08T10:01:00.000Z'));
    const { files, lock } = world({ [later]: text });
    const taking = await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined);
    assert.equal(taking.kind, 'taken');
    assert.equal(files.get(later), text);
  });

  it('names the waiter first in line, and the place in line only when others are ahead', () => {
    const queued: LockWait = { kind: 'queued', first: waiterOf('2030-01-08T09:59:00.000Z') };
    assert.equal(holderText(queued), 'bravo (heavy: lint), first in line since 2030-01-08 09:59');
    assert.equal(waitText(queued, 2), 'bravo (heavy: lint), first in line since 2030-01-08 09:59; 2 ahead in line');
    assert.equal(waitText({ kind: 'unknown' }, 0), 'a writer that has not finished writing');
  });
});

describe('HostLock.release', () => {
  it('removes its own lock', async () => {
    const { files, lock } = world();
    const taking = await lock.tryTake('alpha', 'heavy: test');
    assert.equal(taking.kind === 'taken' ? await lock.release(taking.lock) : false, true);
    assert.equal(files.get(PATH), undefined);
  });

  it('leaves a lock another step took over meanwhile', async () => {
    const { files, lock } = world();
    const taking = await lock.tryTake('alpha', 'heavy: test');
    await files.write(PATH, heldBy());
    assert.equal(taking.kind === 'taken' ? await lock.release(taking.lock) : true, false);
    assert.equal(files.get(PATH), heldBy());
  });
});

describe('HostLock.state', () => {
  const OTHERS: HostLockInfo = { token: 'other', pid: OTHER, session: 'po', purpose: 'heavy: build', acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z' };

  it('reads a free, held or unreadable lock without taking it', async () => {
    assert.deepEqual(await world().lock.state(), { kind: 'free' });
    assert.deepEqual(await world({ [PATH]: heldBy() }).lock.state(), { kind: 'held', info: OTHERS });
    const unreadable = world({ [PATH]: '{"tok' });
    assert.deepEqual(await unreadable.lock.state(), { kind: 'unknown' });
    assert.equal(await unreadable.files.read(PATH), '{"tok', 'nothing is removed');
  });

  it('calls a lock stale once it expired or its process is gone, and leaves it for the next step to remove', async () => {
    assert.deepEqual(await world({ [PATH]: heldBy({ expiresAt: '2030-01-08T10:00:00.000Z' }) }).lock.state(), {
      kind: 'stale',
      info: { ...OTHERS, expiresAt: '2030-01-08T10:00:00.000Z' },
    });
    const gone = world({ [PATH]: heldBy() });
    gone.running.delete(OTHER);
    assert.deepEqual(await gone.lock.state(), { kind: 'stale', info: OTHERS });
    assert.equal(await gone.files.read(PATH), heldBy());
  });
});
