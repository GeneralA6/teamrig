import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sleep } from '../core/lock.ts';
import { KIT_VERSION } from '../core/version.ts';
import { TimeZone } from '../core/zone.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { Files } from '../core/files.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { FIRST_IN_LINE_POLL_MS, HostLock, holderText, TICKET_GRACE_MS, waitText, type HostLockInfo, type HostShare, type LockWait, type LockWaiter, type ShareRequest, type Withdrawal } from './host-lock.ts';

const PATH = '/kit/host.lock';
const QUEUE = `${PATH}.queue`;
const SHARED = `${PATH}.shared`;
const TTL_MS = 150 * 60_000;
const ME = 4242;
const OTHER = 9001;

/** `record` as this teamrig stores it: its id under `token`, the name every reader takes until a later release (T1544). */
function onDisk<T extends { readonly id: string }>(record: T): { readonly token: string } & Omit<T, 'id'> {
  const { id, ...rest } = record;
  return { token: id, ...rest };
}

/** The text of {@link onDisk}. */
function storedText<T extends { readonly id: string }>(record: T): string {
  return JSON.stringify(onDisk(record));
}

/** Another step's lock: taken at 09:50, lasting to 12:20, by a process that runs. */
function infoOf(overrides: Partial<HostLockInfo> = {}): HostLockInfo {
  return { id: 'other', pid: OTHER, session: 'po', purpose: 'heavy: build', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z', ...overrides };
}

/** The file of a lock another step holds ({@link infoOf}). */
function heldBy(overrides: Partial<HostLockInfo> = {}): string {
  return storedText(infoOf(overrides));
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
  return { id: 'bravo', pid: OTHER, session: 'bravo', purpose: 'heavy: lint', kit: KIT_VERSION, arrivedAt, expiresAt: '2030-01-08T11:00:00.000Z', ...overrides };
}

/** A waiter's ticket in the line, `[path, text]`, its text `stores` (default {@link storedText}). */
function ticket(waiter: LockWaiter, stores: (waiter: LockWaiter) => string = storedText): [string, string] {
  return [`${QUEUE}/${String(Date.parse(waiter.arrivedAt)).padStart(15, '0')}-${waiter.id}.json`, stores(waiter)];
}

/** The tickets in the line, by name. */
async function lineOf(files: MemoryFiles): Promise<string[]> {
  return files.list(QUEUE);
}

/** The host lock over \`files\`, as process \`pid\` sees it, with this process and \`OTHER\` running; \`sleep\` default the clock's. */
function lockOver(files: Files, clock: FakeClock, pid: number = ME, sleep: Sleep = clock.sleep): HostLock {
  let ids = 0;
  return new HostLock(PATH, TTL_MS, {
    files,
    clock,
    sleep,
    pid,
    alive: (running) => running === ME || running === OTHER,
    newId: () => {
      ids += 1;
      return `t${ids}`;
    },
  });
}

type Operation = 'read' | 'write' | 'createExclusive';

/** Files in memory where another process acts once, right after this one first does \`operation\` on a path \`at\` picks. */
class Interleaved extends MemoryFiles {
  private readonly operation: Operation;
  private readonly at: (path: string) => boolean;
  private other: ((files: MemoryFiles) => Promise<void>) | undefined;

  constructor(initial: Readonly<Record<string, string>>, operation: Operation, at: (path: string) => boolean, other: (files: MemoryFiles) => Promise<void>) {
    super(initial);
    this.operation = operation;
    this.at = at;
    this.other = other;
  }

  override async read(path: string): Promise<string | undefined> {
    const text = await super.read(path);
    await this.after('read', path);
    return text;
  }

  override async write(path: string, text: string): Promise<void> {
    await super.write(path, text);
    await this.after('write', path);
  }

  override async createExclusive(path: string, text: string): Promise<boolean> {
    const created = await super.createExclusive(path, text);
    await this.after('createExclusive', path);
    return created;
  }

  private async after(operation: Operation, path: string): Promise<void> {
    const other = this.other;
    if (other !== undefined && operation === this.operation && this.at(path)) {
      this.other = undefined;
      await other(this);
    }
  }
}

/** Files in memory where the first removal of `path` comes while its waiter renews it: it finds no file, and the file is back at once. */
class Renewing extends MemoryFiles {
  private readonly path: string;
  private renewing = true;

  constructor(initial: Readonly<Record<string, string>>, path: string) {
    super(initial);
    this.path = path;
  }

  override async remove(path: string): Promise<boolean> {
    if (path === this.path && this.renewing) {
      this.renewing = false;
      return false;
    }
    return super.remove(path);
  }
}

function fileOf(files: MemoryFiles): unknown {
  const text = files.get(PATH);
  return text === undefined ? undefined : JSON.parse(text);
}

describe('HostLock.tryTake', () => {
  it("takes a free lock, writing the file a team's own deploy tool writes too", async () => {
    const { files, lock } = world();
    const taking = await lock.tryTake('alpha', 'heavy: build api');
    const expected = { id: 't1', pid: ME, session: 'alpha', purpose: 'heavy: build api', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:00:00.000Z', expiresAt: '2030-01-08T12:30:00.000Z' };
    assert.deepEqual(taking, { kind: 'taken', lock: expected });
    assert.deepEqual(fileOf(files), onDisk(expected));
  });

  it('names the holder of a live lock and leaves its file', async () => {
    const { files, lock } = world({ [PATH]: heldBy() });
    const taking = await lock.tryTake('alpha', 'heavy: test');
    assert.equal(taking.kind, 'busy');
    assert.equal(taking.kind === 'busy' ? holderText(taking.holder, TimeZone.UTC) : '', 'po (heavy: build) since 2030-01-08 09:50 UTC');
    assert.equal(taking.kind === 'busy' ? holderText(taking.holder, JERUSALEM) : '', 'po (heavy: build) since 2030-01-08 11:50 IST');
    assert.equal(files.get(PATH), heldBy());
  });

  it('names the teamrig a holder took the lock with when another one did, and ignores a kit field another writer uses', async () => {
    const said = async (file: string): Promise<string> => {
      const taking = await world({ [PATH]: file }).lock.tryTake('alpha', 'heavy: test');
      return taking.kind === 'busy' ? holderText(taking.holder, TimeZone.UTC) : '';
    };
    const older = { token: 'other', pid: OTHER, session: 'po', purpose: 'heavy: build', acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z' };
    const unnamed = 'po (heavy: build) since 2030-01-08 09:50 UTC, on an older teamrig or another deploy tool';
    assert.deepEqual(await Promise.all([heldBy(), heldBy({ kit: '0.85.0' }), JSON.stringify(older), JSON.stringify({ ...older, kit: { build: 7 } })].map(said)), [
      'po (heavy: build) since 2030-01-08 09:50 UTC',
      'po (heavy: build) since 2030-01-08 09:50 UTC, on teamrig 0.85.0',
      unnamed,
      unnamed,
    ]);
  });

  it('takes over a lock that has expired', async () => {
    const { files, lock } = world({ [PATH]: heldBy({ expiresAt: '2030-01-08T10:00:00.000Z' }) });
    const taking = await lock.tryTake('alpha', 'heavy: test');
    assert.equal(taking.kind, 'taken');
    assert.deepEqual(fileOf(files), taking.kind === 'taken' ? onDisk(taking.lock) : undefined);
  });

  it('takes over a lock whose process is gone', async () => {
    const { files, running, lock } = world({ [PATH]: heldBy() });
    running.delete(OTHER);
    const taking = await lock.tryTake('alpha', 'heavy: test');
    assert.equal(taking.kind, 'taken');
    assert.equal(taking.kind === 'taken' ? taking.lock.session : '', 'alpha');
    assert.deepEqual(fileOf(files), taking.kind === 'taken' ? onDisk(taking.lock) : undefined);
  });

  it('reads extra fields as the same lock', async () => {
    const { lock } = world({ [PATH]: JSON.stringify({ ...JSON.parse(heldBy()), host: 'box' }) });
    const taking = await lock.tryTake('alpha', 'heavy: test');
    assert.equal(taking.kind === 'busy' && taking.holder.kind === 'held' ? taking.holder.info.id : '', 'other');
  });

  const idless = Object.fromEntries(Object.entries(infoOf()).filter(([key]) => key !== 'id'));
  for (const [label, text] of [
    ['an empty file', ''],
    ['half a file', '{"token":"other","pid":90'],
    ['a time that is not one', heldBy({ expiresAt: 'soon' })],
    ['a file holding null', 'null'],
    ['a lock with no id under either name', JSON.stringify(idless)],
  ] as const) {
    it(`leaves ${label} to its writer and names no holder`, async () => {
      const { files, lock } = world({ [PATH]: text });
      const taking = await lock.tryTake('alpha', 'heavy: test');
      assert.deepEqual(taking, { kind: 'busy', holder: { kind: 'unknown' } });
      assert.equal(holderText({ kind: 'unknown' }, TimeZone.UTC), 'a writer that has not finished writing');
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
    const taking = await lock.acquire('alpha', 'heavy: test', 60 * 60_000, 30_000, (holder) => told.push(holderText(holder, TimeZone.UTC)));
    assert.equal(taking.kind, 'taken');
    assert.deepEqual(told, ['po (heavy: build) since 2030-01-08 09:50 UTC']);
    assert.deepEqual(clock.sleeps, [FIRST_IN_LINE_POLL_MS, FIRST_IN_LINE_POLL_MS]);
    assert.equal(JSON.parse(files.get(PATH) ?? '{}').session, 'alpha');
  });

  it('tells of each new holder', async () => {
    const { lock } = world({ [PATH]: heldBy() }, (time, store) => async (ms) => {
      await time.sleep(ms);
      await store.write(PATH, heldBy({ id: 'third', session: 'bravo' }));
    });
    const told: string[] = [];
    await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, (holder) => told.push(holderText(holder, TimeZone.UTC)));
    assert.deepEqual(told, ['po (heavy: build) since 2030-01-08 09:50 UTC', 'bravo (heavy: build) since 2030-01-08 09:50 UTC']);
  });

  it('gives up at the deadline, never sleeping past it, names the holder and leaves the line', async () => {
    const { clock, files, lock } = world({ [PATH]: heldBy() });
    const taking = await lock.acquire('alpha', 'heavy: test', 5_000, 30_000, () => undefined);
    assert.equal(taking.kind === 'busy' && taking.holder.kind === 'held' ? taking.holder.info.session : '', 'po');
    assert.deepEqual(clock.sleeps, [2_000, 2_000, 1_000]);
    assert.equal(files.get(PATH), heldBy());
    assert.deepEqual(await lineOf(files), []);
  });

  it('stops waiting once its stop aborts, rejecting with its reason and leaving the lock to its holder', async () => {
    const stop = new AbortController();
    const { clock, files, lock } = world({ [PATH]: heldBy() }, (time) => async (ms) => {
      await time.sleep(ms);
      stop.abort();
    });
    await assert.rejects(lock.acquire('alpha', 'heavy: test', 60 * 60_000, 30_000, () => undefined, undefined, stop.signal), (error) => error === stop.signal.reason);
    assert.deepEqual([clock.sleeps, files.get(PATH), await lineOf(files)], [[FIRST_IN_LINE_POLL_MS], heldBy(), []], 'it left the line');
  });

  it('never takes even a free lock once its stop has aborted', async () => {
    const { files, lock } = world();
    const stop = AbortSignal.abort();
    await assert.rejects(lock.acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined, undefined, stop), (error) => error === stop.reason);
    assert.deepEqual([files.get(PATH), await lineOf(files)], [undefined, []]);
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
    const taking = await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, (holder) => told.push(holderText(holder, TimeZone.UTC)));
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
  it('writes its ticket while it waits: named by its arrival, with its process, its deadline and grace, and that it stops on withdraw', async () => {
    const seen: string[] = [];
    const { files, lock } = world({ [PATH]: heldBy() }, (time, store) => async (ms) => {
      for (const name of await store.list(QUEUE)) {
        seen.push(`${name} ${store.get(`${QUEUE}/${name}`) ?? ''}`);
      }
      await time.sleep(ms);
    });
    await lock.acquire('alpha', 'heavy: test', 2_000, 30_000, () => undefined);
    const mine = waiterOf('2030-01-08T10:00:00.000Z', {
      id: 't1',
      pid: ME,
      session: 'alpha',
      purpose: 'heavy: test',
      expiresAt: new Date(Date.parse('2030-01-08T10:00:02.000Z') + TICKET_GRACE_MS).toISOString(),
      stopsOnWithdraw: true,
    });
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
        await store.write(PATH, heldBy({ id: 'bravo-lock', session: 'bravo' }));
        await store.remove(early);
      } else {
        await store.remove(PATH);
      }
    });
    const told: string[] = [];
    const taking = await lock.acquire('alpha', 'heavy: test', 60 * 60_000, 30_000, (holder, ahead) => told.push(waitText(holder, ahead, TimeZone.UTC)));
    assert.equal(taking.kind, 'taken');
    assert.deepEqual(told, [
      'po (heavy: build) since 2030-01-08 09:50 UTC; 1 ahead in line',
      'bravo (heavy: lint), first in line since 2030-01-08 09:59 UTC; 1 ahead in line',
      'bravo (heavy: build) since 2030-01-08 09:50 UTC',
    ]);
    assert.deepEqual(clock.sleeps, [30_000, 30_000, FIRST_IN_LINE_POLL_MS], 'behind a waiter it looks every poll, first in line every 2 s');
    assert.deepEqual([fileOf(files), taking.kind === 'taken' ? taking.lock.id : ''], [
      { token: 't1', pid: ME, session: 'alpha', purpose: 'heavy: test', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:01:02.000Z', expiresAt: '2030-01-08T12:31:02.000Z' },
      't1',
    ], "the lock carries its ticket's id: one step, one id, from joining the line to releasing");
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
    const gone = ticket(waiterOf('2030-01-08T09:57:00.000Z', { id: 'gone', pid: 7 }));
    const late = ticket(waiterOf('2030-01-08T09:58:00.000Z', { id: 'late', expiresAt: '2030-01-08T10:00:00.000Z' }));
    const [damaged] = ticket(waiterOf('2030-01-08T09:59:00.000Z', { id: 'damaged' }));
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
    assert.equal(holderText(queued, TimeZone.UTC), 'bravo (heavy: lint), first in line since 2030-01-08 09:59 UTC');
    assert.equal(holderText(queued, JERUSALEM), 'bravo (heavy: lint), first in line since 2030-01-08 11:59 IST');
    assert.equal(waitText(queued, 2, TimeZone.UTC), 'bravo (heavy: lint), first in line since 2030-01-08 09:59 UTC; 2 ahead in line');
    assert.equal(waitText({ kind: 'unknown' }, 0, TimeZone.UTC), 'a writer that has not finished writing');
  });
});

describe('HostLock.acquire in a moving line', () => {
  it('waits on while its line moves, giving up once it has not moved for its whole wait, its ticket lasting as long', async () => {
    const [early, text] = ticket(waiterOf('2030-01-08T09:58:00.000Z', { id: 'early' }));
    const expiries: string[] = [];
    let sleeps = 0;
    const { clock, files, lock } = world({ [PATH]: heldBy(), [early]: text }, (time, store) => async (ms) => {
      const [mine] = (await store.list(QUEUE)).filter((name) => name.endsWith('-t1.json'));
      const expiresAt = String(JSON.parse(store.get(`${QUEUE}/${mine}`) ?? '{}').expiresAt);
      if (expiries.at(-1) !== expiresAt) {
        expiries.push(expiresAt);
      }
      await time.sleep(ms);
      sleeps += 1;
      if (sleeps === 1) {
        await store.remove(early);
      }
    });
    const taking = await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined);
    assert.equal(taking.kind === 'busy' && taking.holder.kind === 'held' ? taking.holder.info.session : '', 'po');
    assert.equal(clock.sleeps.reduce((total, ms) => total + ms, 0), 90_000, 'the line moved at 10:00:30, so its wait ran out a minute later');
    assert.deepEqual(expiries, [new Date(Date.parse('2030-01-08T10:01:00.000Z') + TICKET_GRACE_MS).toISOString(), new Date(Date.parse('2030-01-08T10:01:30.000Z') + TICKET_GRACE_MS).toISOString()]);
    assert.deepEqual(await lineOf(files), []);
  });

  for (const [label, initial, change] of [
    ['a new holder of the lock', { [PATH]: heldBy() }, (store: MemoryFiles) => store.write(PATH, heldBy({ id: 'third', session: 'bravo' }))],
    [
      'a small step that ended while it held the lock for them',
      Object.fromEntries([shareFile(shareOf()), shareFile(shareOf({ id: 'second' }))]),
      async (store: MemoryFiles) => {
        await store.remove(shareFile(shareOf())[0]);
      },
    ],
    [
      'a small step that ended while the holder waited for it',
      Object.fromEntries([[PATH, heldBy()], shareFile(shareOf({ id: 's1' })), shareFile(shareOf({ id: 's2' }))]),
      async (store: MemoryFiles) => {
        await store.remove(shareFile(shareOf({ id: 's1' }))[0]);
      },
    ],
  ] as const) {
    it(`counts ${label} as the line moving`, async () => {
      let sleeps = 0;
      const { clock, lock } = world(initial, (time, store) => async (ms) => {
        await time.sleep(ms);
        sleeps += 1;
        if (sleeps === 1) {
          await change(store);
        }
      });
      const taking = await lock.acquire('alpha', 'heavy: build', 5_000, 30_000, () => undefined);
      assert.deepEqual([taking.kind, clock.sleeps], ['busy', [2_000, 2_000, 2_000, 1_000]], 'moved at 10:00:02, its wait ran out 5 s later');
    });
  }

  it('stops, never writing its ticket back, when the ticket was withdrawn as the line moved', async () => {
    const clock = new FakeClock('2030-01-08T10:00:00Z');
    let reads = 0;
    let done: Withdrawal[] = [];
    const files = new Interleaved({ [PATH]: heldBy() }, 'read', (path) => path === PATH && ++reads === 2, async (store) => {
      done = await lockOver(store, clock, 77).withdraw('alpha', () => true);
    });
    const sleep: Sleep = async (ms) => {
      await clock.sleep(ms);
      await files.write(PATH, heldBy({ id: 'third', session: 'bravo' }));
    };
    const taking = await lockOver(files, clock, ME, sleep).acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined);
    assert.deepEqual([taking, done.map((withdrawal) => withdrawal.kind), await lineOf(files)], [{ kind: 'withdrawn' }, ['withdrawn'], []]);
  });

  it('withdraws a ticket its waiter was renewing once it is back in line', async () => {
    const waiter = waiterOf('2030-01-08T09:59:00.000Z', { session: 'alpha', stopsOnWithdraw: true });
    const [path, text] = ticket(waiter);
    const files = new Renewing({ [path]: text }, path);
    assert.deepEqual(await lockOver(files, new FakeClock('2030-01-08T10:00:00Z'), 77).withdraw('alpha', () => true), [{ kind: 'withdrawn', waiter }]);
    assert.deepEqual(await lineOf(files), []);
  });
});

describe('HostLock.withdraw', () => {
  it('stops a waiting step at its next look once its ticket is withdrawn, taking nothing', async () => {
    let done: Withdrawal[] = [];
    const { clock, files, lock } = world({ [PATH]: heldBy() }, (time, store) => async (ms) => {
      await time.sleep(ms);
      done = await lockOver(store, time, 77).withdraw('alpha', () => true);
    });
    const taking = await lock.acquire('alpha', 'heavy: test', 60 * 60_000, 30_000, () => undefined);
    assert.deepEqual([taking, done.map((withdrawal) => `${withdrawal.kind} ${withdrawal.waiter.purpose}`)], [{ kind: 'withdrawn' }, ['withdrawn heavy: test']]);
    assert.deepEqual([fileOf(files), await lineOf(files), clock.sleeps], [JSON.parse(heldBy()), [], [FIRST_IN_LINE_POLL_MS]]);
  });

  it('stops a step holding the lock while small steps end once withdrawn, releasing the lock', async () => {
    const [path, text] = shareFile(shareOf());
    let done: Withdrawal[] = [];
    const { files, lock } = world({ [path]: text }, (time, store) => async (ms) => {
      await time.sleep(ms);
      done = await lockOver(store, time, 77).withdraw('alpha', () => true);
    });
    const taking = await lock.acquire('alpha', 'heavy: build', 60 * 60_000, 30_000, () => undefined);
    assert.deepEqual([taking, done.map((withdrawal) => withdrawal.kind)], [{ kind: 'withdrawn' }, ['withdrawn']]);
    assert.deepEqual([files.get(PATH), files.get(path), await lineOf(files)], [undefined, text, []], 'it released its lock and left the share');
  });

  for (const [label, share, operation, at] of [
    ['the lock', undefined, 'createExclusive', (path: string) => path.endsWith('host.lock')],
    ['a share', small(64_000), 'write', (path: string) => path.endsWith('t1.json') && !path.includes('queue')],
  ] as const) {
    it(`releases ${label} it took when its ticket was withdrawn as it took its turn`, async () => {
      const clock = new FakeClock('2030-01-08T10:00:00Z');
      let done: Withdrawal[] = [];
      const files = new Interleaved({}, operation, at, async (store) => {
        done = await lockOver(store, clock, 77).withdraw('alpha', () => true);
      });
      const taking = await lockOver(files, clock).acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined, share);
      assert.deepEqual([taking, done.map((withdrawal) => withdrawal.kind)], [{ kind: 'withdrawn' }, ['withdrawn']]);
      assert.deepEqual([files.get(PATH), await files.list(SHARED), await lineOf(files)], [undefined, [], []]);
    });
  }

  for (const [took, kind] of [
    [true, 'running'],
    [false, 'left'],
  ] as const) {
    it(`names a step that took its turn first ${kind}, as it ${took ? "runs" : "ran or gave up"}`, async () => {
      const waiter = waiterOf('2030-01-08T09:59:00.000Z', { session: 'alpha', stopsOnWithdraw: true });
      const [path, text] = ticket(waiter);
      const clock = new FakeClock('2030-01-08T10:00:00Z');
      const files = new Interleaved({ [path]: text }, 'read', (read) => read.endsWith('-bravo.json'), async (store) => {
        await store.remove(path);
        if (took) {
          await store.write(PATH, heldBy({ id: 'bravo', session: 'alpha' }));
        }
      });
      assert.deepEqual(await lockOver(files, clock, 77).withdraw('alpha', () => true), [{ kind, waiter }]);
    });
  }

  it("keeps an older kit's ticket, as its step runs anyway, and leaves other sessions', stale and unchosen tickets", async () => {
    const old = ticket(waiterOf('2030-01-08T09:55:00.000Z', { id: 'old', session: 'alpha' }));
    const lint = ticket(waiterOf('2030-01-08T09:56:00.000Z', { id: 'lint', session: 'alpha', stopsOnWithdraw: true }));
    const build = ticket(waiterOf('2030-01-08T09:57:00.000Z', { id: 'build', session: 'alpha', purpose: 'heavy: build', stopsOnWithdraw: true }));
    const theirs = ticket(waiterOf('2030-01-08T09:58:00.000Z', { id: 'theirs', stopsOnWithdraw: true }));
    const gone = ticket(waiterOf('2030-01-08T09:59:00.000Z', { id: 'gone', session: 'alpha', pid: 7, stopsOnWithdraw: true }));
    const { files, lock } = world(Object.fromEntries([old, lint, build, theirs, gone]));
    const done = await lock.withdraw('alpha', (waiter) => waiter.purpose.includes('lint'));
    assert.deepEqual(done.map((withdrawal) => `${withdrawal.kind} ${withdrawal.waiter.id}`), ['kept old', 'withdrawn lint']);
    assert.deepEqual(await lineOf(files), [old, build, theirs, gone].map(([path]) => path.slice(QUEUE.length + 1)));
  });

  it('lists the live waiters oldest first, leaving a stale or unreadable ticket to the next waiter', async () => {
    const first = waiterOf('2030-01-08T09:58:00.000Z', { id: 'first' });
    const second = waiterOf('2030-01-08T09:59:00.000Z', { id: 'second', session: 'alpha', stopsOnWithdraw: true });
    const gone = ticket(waiterOf('2030-01-08T09:57:00.000Z', { id: 'gone', pid: 7 }));
    const [odd] = ticket(waiterOf('2030-01-08T09:56:00.000Z', { id: 'odd' }));
    const { files, lock } = world(Object.fromEntries([ticket(second), ticket(first), gone, [odd, storedText({ ...first, stopsOnWithdraw: 'yes' })]]));
    assert.deepEqual(await lock.line(), [first, second]);
    assert.equal((await lineOf(files)).length, 4);
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
  const OTHERS: HostLockInfo = { id: 'other', pid: OTHER, session: 'po', purpose: 'heavy: build', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z' };

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

/** A small step sharing the host: po's spec run since 09:50, lasting to 12:20, by `OTHER`, 2048 MB held for it. */
function shareOf(overrides: Partial<HostShare> = {}): HostShare {
  return { id: 'other', pid: OTHER, session: 'po', purpose: 'heavy: specs', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z', reserveMb: 2048, ...overrides };
}

/** A share's file, `[path, text]`, its text `stores` (default {@link storedText}). */
function shareFile(share: HostShare, stores: (share: HostShare) => string = storedText): [string, string] {
  return [`${SHARED}/${share.id}.json`, stores(share)];
}

/** A small step asking for 2048 MB with 4096 kept free, on a host with `freeMb` free. */
function small(freeMb: number): ShareRequest {
  return { reserveMb: 2048, floorMb: 4096, freeMb: () => freeMb };
}

describe('HostLock shares', () => {
  it('lets a small step share a free host at once, alone whatever the free memory, leaving the lock and the line', async () => {
    const { files, lock } = world();
    const taking = await lock.acquire('alpha', 'heavy: specs', 60_000, 30_000, () => undefined, small(1000));
    const share = { id: 't1', pid: ME, session: 'alpha', purpose: 'heavy: specs', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:00:00.000Z', expiresAt: '2030-01-08T12:30:00.000Z', reserveMb: 2048 };
    assert.deepEqual(taking, { kind: 'taken', lock: share, sharing: { freeMb: 1000, others: [] } });
    assert.deepEqual([files.get(PATH), files.get(`${SHARED}/t1.json`), await lineOf(files)], [undefined, storedText(share), []]);
  });

  it('lets another small step in while the free memory less the MB held for the others leaves the floor and its own', async () => {
    const [path, text] = shareFile(shareOf());
    const { lock } = world({ [path]: text });
    const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, small(8192));
    assert.deepEqual(taking.kind === 'taken' ? taking.sharing : undefined, { freeMb: 8192, others: [shareOf()] });
  });

  it('keeps a small step waiting while memory is short, telling of it once, and lets it in when the share ends', async () => {
    const [path, text] = shareFile(shareOf());
    let sleeps = 0;
    const { clock, lock } = world({ [path]: text }, (time, store) => async (ms) => {
      await time.sleep(ms);
      sleeps += 1;
      if (sleeps === 2) {
        await store.remove(path);
      }
    });
    const told: string[] = [];
    const taking = await lock.acquire('alpha', 'heavy: specs', 60_000, 30_000, (holder, ahead) => told.push(waitText(holder, ahead, TimeZone.UTC)), small(8191));
    assert.deepEqual(told, ['1 small step: po (heavy: specs) since 2030-01-08 09:50 UTC; 8191 MB free, 2048 MB held for it, 6144 MB needed']);
    assert.deepEqual(clock.sleeps, [FIRST_IN_LINE_POLL_MS, FIRST_IN_LINE_POLL_MS]);
    assert.deepEqual(taking.kind === 'taken' ? taking.sharing : undefined, { freeMb: 8191, others: [] });
  });

  it('gives up when memory stays short through its wait, writing no share', async () => {
    const [path, text] = shareFile(shareOf());
    const { files, lock } = world({ [path]: text });
    const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, small(100));
    assert.equal(taking.kind === 'busy' ? taking.holder.kind : '', 'memory');
    assert.deepEqual([await files.list(SHARED), await lineOf(files)], [['other.json'], []]);
  });

  it('never shares a host whose lock is held, nor ahead of an earlier waiter', async () => {
    const held = world({ [PATH]: heldBy() });
    const busy = await held.lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, small(64_000));
    const [early, text] = ticket(waiterOf('2030-01-08T09:59:00.000Z'));
    const queued = world({ [early]: text });
    const behind = await queued.lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, small(64_000));
    assert.deepEqual([busy.kind === 'busy' ? busy.holder.kind : '', behind.kind === 'busy' ? behind.holder.kind : ''], ['held', 'queued']);
    assert.deepEqual([await held.files.list(SHARED), await queued.files.list(SHARED)], [[], []]);
  });

  it('shares a host whose lock is stale, leaving that lock for the next step that takes the lock', async () => {
    const { files, lock } = world({ [PATH]: heldBy({ pid: 7 }) });
    const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, small(1000));
    assert.equal(taking.kind === 'taken' ? taking.sharing?.freeMb : undefined, 1000);
    assert.equal(files.get(PATH), heldBy({ pid: 7 }));
  });

  it('removes a file it cannot read once it has seen it so for 10 seconds, then shares the host', async () => {
    const { clock, files, lock } = world({ [PATH]: '{"tok' });
    const taking = await lock.acquire('alpha', 'heavy: specs', 60_000, 30_000, () => undefined, small(1000));
    assert.equal(taking.kind === 'taken' ? taking.sharing?.freeMb : undefined, 1000);
    assert.deepEqual([clock.sleeps.length, files.get(PATH)], [HostLock.UNREADABLE_GRACE_MS / FIRST_IN_LINE_POLL_MS, undefined]);
  });

  it('makes a step that took the lock wait, holding it, for the shares to end, then renews its lock', async () => {
    const [path, text] = shareFile(shareOf());
    const holders: unknown[] = [];
    let sleeps = 0;
    const { clock, files, lock } = world({ [path]: text }, (time, store) => async (ms) => {
      holders.push(JSON.parse(store.get(PATH) ?? '{}').session);
      await time.sleep(ms);
      sleeps += 1;
      if (sleeps === 2) {
        await store.remove(path);
      }
    });
    const told: string[] = [];
    const taking = await lock.acquire('alpha', 'heavy: build', 60 * 60_000, 30_000, (holder) => told.push(holderText(holder, TimeZone.UTC)));
    assert.deepEqual(told, ['1 small step: po (heavy: specs) since 2030-01-08 09:50 UTC']);
    assert.deepEqual([clock.sleeps, holders], [[FIRST_IN_LINE_POLL_MS, FIRST_IN_LINE_POLL_MS], ['alpha', 'alpha']], 'it holds the lock while it waits');
    const renewed = { id: 't1', pid: ME, session: 'alpha', purpose: 'heavy: build', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:00:00.000Z', expiresAt: '2030-01-08T12:30:04.000Z' };
    assert.deepEqual([taking, fileOf(files)], [{ kind: 'taken', lock: renewed }, onDisk(renewed)]);
  });

  it('gives up when the shares outlast its wait, releasing the lock it took', async () => {
    const [path, text] = shareFile(shareOf());
    const { clock, files, lock } = world({ [path]: text });
    const taking = await lock.acquire('alpha', 'heavy: build', 5_000, 30_000, () => undefined);
    assert.equal(taking.kind === 'busy' ? taking.holder.kind : '', 'draining');
    assert.deepEqual([clock.sleeps, files.get(PATH), files.get(path), await lineOf(files)], [[2_000, 2_000, 1_000], undefined, text, []]);
  });

  it('releases the lock it took and rejects once its stop aborts while the shares end', async () => {
    const [path, text] = shareFile(shareOf());
    const stop = new AbortController();
    const { clock, files, lock } = world({ [path]: text }, (time) => async (ms) => {
      await time.sleep(ms);
      stop.abort();
    });
    await assert.rejects(lock.acquire('alpha', 'heavy: build', 60 * 60_000, 30_000, () => undefined, undefined, stop.signal), (error) => error === stop.signal.reason);
    assert.deepEqual([clock.sleeps, files.get(PATH), files.get(path), await lineOf(files)], [[FIRST_IN_LINE_POLL_MS], undefined, text, []]);
  });

  it('never holds its lock past the lock expiry while it waits for the shares', async () => {
    const [path, text] = shareFile(shareOf({ expiresAt: '2030-01-09T10:00:00.000Z' }));
    const { clock, files, lock } = world({ [path]: text });
    const taking = await lock.acquire('alpha', 'heavy: build', 4 * TTL_MS, 30_000, () => undefined);
    assert.equal(taking.kind === 'busy' ? taking.holder.kind : '', 'draining');
    assert.deepEqual([clock.sleeps.reduce((total, ms) => total + ms, 0), files.get(PATH)], [TTL_MS, undefined]);
  });

  it("removes a share whose process is gone, that expired or that cannot be read, and keeps a writer's temporary file", async () => {
    const gone = shareFile(shareOf({ id: 'gone', pid: 7 }));
    const late = shareFile(shareOf({ id: 'late', expiresAt: '2030-01-08T10:00:00.000Z' }));
    const { clock, files, lock } = world(
      Object.fromEntries([gone, late, [`${SHARED}/damaged.json`, '{"tok'], [`${SHARED}/fresh.json.9001.1.tmp`, '{"tok']]),
    );
    assert.equal((await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined)).kind, 'taken');
    assert.deepEqual([clock.sleeps, await files.list(SHARED)], [[], ['fresh.json.9001.1.tmp']]);
  });

  it('finds a live share by its id and releases it; lists the live shares oldest first, removing none', async () => {
    const later = shareOf({ id: 'a-later', session: 'web', acquiredAt: '2030-01-08T09:55:00.000Z' });
    const stale = shareFile(shareOf({ id: 'stale', pid: 7 }));
    const { files, lock } = world(Object.fromEntries([shareFile(shareOf()), shareFile(later), stale]));
    assert.deepEqual(await lock.heldWith('other'), shareOf());
    assert.deepEqual([await lock.heldWith('stale'), await lock.heldWith('../other'), await lock.heldWith('missing')], [undefined, undefined, undefined]);
    assert.deepEqual([await lock.shares(), files.get(stale[0])], [[shareOf(), later], stale[1]]);
    assert.equal(await lock.release(shareOf()), true);
    assert.deepEqual([files.get(shareFile(shareOf())[0]), await lock.release(shareOf())], [undefined, false]);
  });

  it('names the small steps, and the memory they leave, as a waiter reads them', () => {
    const shares = [shareOf(), shareOf({ id: 'b', session: 'web', purpose: 'heavy: lint', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:55:00.000Z' })];
    const steps = '2 small steps: po (heavy: specs) since 2030-01-08 09:50 UTC, web (heavy: lint) since 2030-01-08 09:55 UTC';
    assert.equal(holderText({ kind: 'draining', shares }, TimeZone.UTC), steps);
    assert.equal(holderText({ kind: 'memory', freeMb: 7000, heldMb: 4096, needMb: 6144, shares }, TimeZone.UTC), `${steps}; 7000 MB free, 4096 MB held for them, 6144 MB needed`);
    const holder = shareOf({ id: 'h', purpose: 'heavy: build', kit: '0.1.0' });
    assert.equal(holderText({ kind: 'held', info: holder, waitsFor: shares }, TimeZone.UTC), `po (heavy: build) since 2030-01-08 09:50 UTC, on teamrig 0.1.0, waiting for ${steps}`);
  });

  it('names the small steps a holder still waits for, to a step and to a small step waiting behind it', async () => {
    const info: HostLockInfo = { id: 'other', pid: OTHER, session: 'po', purpose: 'heavy: build', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z' };
    const web = shareOf({ id: 's1', session: 'web', acquiredAt: '2030-01-08T09:55:00.000Z' });
    const initial = Object.fromEntries([[PATH, storedText(info)], shareFile(web), shareFile(shareOf({ id: 'gone', pid: 7 }))]);
    const told: string[] = [];
    const step = await world(initial).lock.acquire('alpha', 'heavy: build', 0, 30_000, (holder) => told.push(holderText(holder, TimeZone.UTC)));
    const smallStep = await world(initial).lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, small(64_000));
    const busy = { kind: 'busy', holder: { kind: 'held', info, waitsFor: [web] } };
    assert.deepEqual([step, smallStep], [busy, busy], 'a stale share is no step it waits for');
    assert.deepEqual(told, ['po (heavy: build) since 2030-01-08 09:50 UTC, waiting for 1 small step: web (heavy: specs) since 2030-01-08 09:55 UTC']);
  });

  it('names no small step for a holder without a kit, which runs beside them, nor for one with none sharing the host', async () => {
    const older: HostLockInfo = { id: 'other', pid: OTHER, session: 'po', purpose: 'heavy: build', acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z' };
    const kitless = world(Object.fromEntries([[PATH, storedText(older)], shareFile(shareOf({ id: 's1' }))]));
    const alone = world({ [PATH]: heldBy() });
    const takings = [await kitless.lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined), await alone.lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined)];
    assert.deepEqual(
      takings.map((taking) => (taking.kind === 'busy' && taking.holder.kind === 'held' ? Object.keys(taking.holder) : [])),
      [
        ['kind', 'info'],
        ['kind', 'info'],
      ],
    );
  });
});

describe('HostLock ids, stored as token until every reader takes id (T1544)', () => {
  /** `record` as a newer teamrig stores it: its id under `id`. */
  const newer = (record: { readonly id: string }): string => JSON.stringify(record);

  it("respects a newer teamrig's lock, share and ticket stored under id: busy, named, none removed", async () => {
    const held = world({ [PATH]: newer(infoOf()) });
    const taking = await held.lock.tryTake('alpha', 'heavy: test');
    assert.deepEqual([taking, held.files.get(PATH)], [{ kind: 'busy', holder: { kind: 'held', info: infoOf() } }, newer(infoOf())]);

    const [path, text] = shareFile(shareOf(), newer);
    const shared = world({ [path]: text });
    const build = await shared.lock.acquire('alpha', 'heavy: build', 5_000, 30_000, () => undefined);
    assert.deepEqual([build.kind === 'busy' ? build.holder.kind : '', shared.files.get(path), await shared.lock.heldWith('other')], ['draining', text, shareOf()]);

    const waiter = waiterOf('2030-01-08T09:59:00.000Z');
    const [early, ticketText] = ticket(waiter, newer);
    const queued = world({ [early]: ticketText });
    const behind = await queued.lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined);
    assert.deepEqual([behind.kind === 'busy' && behind.holder.kind === 'queued' ? behind.holder.first : undefined, queued.files.get(early)], [waiter, ticketText]);
  });

  it("stores the id of each lock, ticket and share it writes under token alone, first, as an older teamrig and a team's own deploy tool read it", async () => {
    const tickets: string[] = [];
    const { files, lock } = world({ [PATH]: heldBy() }, (time, store) => async (ms) => {
      for (const name of await store.list(QUEUE)) {
        tickets.push(store.get(`${QUEUE}/${name}`) ?? '{}');
      }
      await time.sleep(ms);
      await store.remove(PATH);
    });
    assert.equal((await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined)).kind, 'taken');
    const sharing = world();
    assert.equal((await sharing.lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, small(1000))).kind, 'taken');
    const texts = [tickets[0], files.get(PATH), sharing.files.get(`${SHARED}/t1.json`)];
    assert.deepEqual(
      texts.map((text) => Object.keys(JSON.parse(text ?? '{}'))).map((keys) => [keys[0], keys.includes('id')]),
      [
        ['token', false],
        ['token', false],
        ['token', false],
      ],
    );
  });

  it('reads the id under id alone when a file holds both names, keeping no token to write back', async () => {
    const { lock } = world({ [PATH]: JSON.stringify({ ...onDisk(infoOf({ id: 'older-name' })), id: 'other' }) });
    const state = await lock.state();
    assert.deepEqual(state.kind === 'held' ? state.info : undefined, infoOf());
  });
});
