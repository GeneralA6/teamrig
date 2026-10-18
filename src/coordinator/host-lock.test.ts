import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sleep } from '../core/lock.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { HostLock, holderText, type HostLockInfo, type LockHolder } from './host-lock.ts';

const PATH = '/kit/host.lock';
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
  it('takes a free lock at once, telling no one it waited', async () => {
    const { clock, lock } = world();
    const told: LockHolder[] = [];
    const taking = await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, (holder) => told.push(holder));
    assert.equal(taking.kind, 'taken');
    assert.deepEqual([told, clock.sleeps], [[], []]);
  });

  it('looks again every poll until the holder releases, telling of it once', async () => {
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
    assert.deepEqual(clock.sleeps, [30_000, 30_000]);
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

  it('gives up at the deadline, never sleeping past it, and names the holder', async () => {
    const { clock, files, lock } = world({ [PATH]: heldBy() });
    const taking = await lock.acquire('alpha', 'heavy: test', 45_000, 30_000, () => undefined);
    assert.equal(taking.kind === 'busy' && taking.holder.kind === 'held' ? taking.holder.info.session : '', 'po');
    assert.deepEqual(clock.sleeps, [30_000, 15_000]);
    assert.equal(files.get(PATH), heldBy());
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
    const taking = await lock.acquire('alpha', 'heavy: test', 60_000, 5_000, (holder) => told.push(holderText(holder)));
    assert.equal(taking.kind, 'taken');
    assert.deepEqual(told, ['a writer that has not finished writing']);
    assert.deepEqual(clock.sleeps, [5_000, 5_000]);
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
