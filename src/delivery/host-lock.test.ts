import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sleep } from '../core/lock.ts';
import { KIT_VERSION } from '../core/version.ts';
import { TimeZone } from '../core/zone.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { Files } from '../core/files.ts';
import { FakeHostMemory, noLoadingTabs } from '../testing/fake-host-memory.ts';
import { JERUSALEM } from '../testing/zone.ts';
import type { AdmissionRules } from './admission.ts';
import type { OpenCharge } from './class-turns.ts';
import {
  busyText,
  FIRST_IN_LINE_POLL_MS,
  HostLock,
  holderText,
  isHeavyShare,
  sharesCount,
  sharesText,
  TICKET_GRACE_MS,
  waitText,
  type HostLockInfo,
  type HostShare,
  type LockWait,
  type LockWaiter,
  type StepNeed,
  type Taking,
  type TicketRequest,
  type WaitingOn,
  type Withdrawal,
} from './host-lock.ts';
import { MemoryGate, type MemoryGateConfig } from './memory-gate.ts';
import type { LineRequest } from './process-request.ts';

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

/** The memory gate's limits in these specs: the config defaults. */
const GATE: MemoryGateConfig = { floorMb: 4096, heavyReserveMb: 4096, commitMaxPct: 92 };

/** A small step holding 2048 MB, so the gate needs 6144 MB free for it beside the MB held for the other small steps. */
const SMALL: StepNeed = { shares: true, reserveMb: 2048 };

/** The gate's gaps between its reads take no time here (memory-gate.test.ts times them), so a spec's sleeps stay the lock's own. */
const noGap: Sleep = async () => undefined;

/**
 * The host lock over files in memory at 10:00, with this process and `OTHER` running; `sleep` default the clock's.
 * With `memory`, every step passes a memory gate ({@link GATE}) over that host first; with `admission`, the line is
 * ordered by those rules.
 */
function world(initial: Readonly<Record<string, string>> = {}, sleep?: (clock: FakeClock, files: MemoryFiles) => Sleep, memory?: FakeHostMemory, admission?: AdmissionRules): World {
  const files = new MemoryFiles(initial);
  const clock = new FakeClock('2030-01-08T10:00:00Z');
  const running = new Set([ME, OTHER]);
  let ids = 0;
  const lock = new HostLock(PATH, TTL_MS, {
    files,
    clock,
    sleep: sleep === undefined ? clock.sleep : sleep(clock, files),
    pid: ME,
    zone: JERUSALEM,
    alive: (pid) => running.has(pid),
    newId: () => {
      ids += 1;
      return `t${ids}`;
    },
    ...(memory === undefined ? {} : { memory: new MemoryGate(memory, noGap, GATE, noLoadingTabs) }),
    ...(admission === undefined ? {} : { admission }),
  });
  return { files, clock, running, lock };
}

/** What a step that joined the line at 10:00 behind the lock {@link infoOf} holds says it waits on, on the team's clock. */
const HELD_BY_PO: WaitingOn = { reason: 'lock', text: 'po (heavy: build) since 2030-01-08 11:50 IST', since: '2030-01-08T10:00:00.000Z' };

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

/**
 * The host lock over \`files\`, as process \`pid\` sees it, with this process and \`OTHER\` running; \`sleep\` default the
 * clock's; with \`admission\`, the line ordered by those rules.
 */
function lockOver(files: Files, clock: FakeClock, pid: number = ME, sleep: Sleep = clock.sleep, admission?: AdmissionRules): HostLock {
  let ids = 0;
  return new HostLock(PATH, TTL_MS, {
    files,
    clock,
    sleep,
    pid,
    zone: JERUSALEM,
    alive: (running) => running === ME || running === OTHER,
    newId: () => {
      ids += 1;
      return `t${ids}`;
    },
    ...(admission === undefined ? {} : { admission }),
  });
}

type Operation = 'read' | 'write' | 'createExclusive' | 'remove';

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

  override async remove(path: string): Promise<boolean> {
    const removed = await super.remove(path);
    await this.after('remove', path);
    return removed;
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

  it("reads a lock file with only the six fields the delivery owner's coordinator writes as its holder, and writes all six itself (T2209)", async () => {
    const coordinator = { token: 'coord-1', pid: OTHER, session: 'po', purpose: 'deploy api', acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z' };
    const busy = await world({ [PATH]: JSON.stringify(coordinator) }).lock.tryTake('alpha', 'heavy: test');
    const holder = busy.kind === 'busy' && busy.holder.kind === 'held' ? busy.holder.info : undefined;
    assert.deepEqual(holder === undefined ? undefined : [holder.id, holder.pid, holder.session, holder.purpose, holder.acquiredAt, holder.expiresAt], ['coord-1', OTHER, 'po', 'deploy api', '2030-01-08T09:50:00.000Z', '2030-01-08T12:20:00.000Z']);
    const { files, lock } = world();
    await lock.tryTake('alpha', 'heavy: build api');
    const written = fileOf(files);
    const kept = Object.keys(coordinator).filter((key) => typeof written === 'object' && written !== null && key in written);
    assert.deepEqual(kept, ['token', 'pid', 'session', 'purpose', 'acquiredAt', 'expiresAt']);
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
  it('writes its ticket while it waits: named by its arrival, with its process, its deadline and grace, that it stops on withdraw, and what it waits on', async () => {
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
      waitingOn: HELD_BY_PO,
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

  for (const [label, ask, operation, at] of [
    ['the lock', {}, 'createExclusive', (path: string) => path.endsWith('host.lock')],
    ['a share', { need: SMALL }, 'write', (path: string) => path.endsWith('t1.json') && !path.includes('queue')],
  ] as const) {
    it(`releases ${label} it took when its ticket was withdrawn as it took its turn`, async () => {
      const clock = new FakeClock('2030-01-08T10:00:00Z');
      let done: Withdrawal[] = [];
      const files = new Interleaved({}, operation, at, async (store) => {
        done = await lockOver(store, clock, 77).withdraw('alpha', () => true);
      });
      const taking = await lockOver(files, clock).acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined, ask);
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

describe('HostLock shares', () => {
  it('lets a lone small step share a free host once free memory leaves the floor and its own MB, leaving the lock and the line', async () => {
    const { files, lock } = world({}, undefined, new FakeHostMemory(6144));
    const taking = await lock.acquire('alpha', 'heavy: specs', 60_000, 30_000, () => undefined, { need: SMALL });
    const share = { id: 't1', pid: ME, session: 'alpha', purpose: 'heavy: specs', kit: KIT_VERSION, acquiredAt: '2030-01-08T10:00:00.000Z', expiresAt: '2030-01-08T12:30:00.000Z', reserveMb: 2048 };
    assert.deepEqual(taking, { kind: 'taken', lock: share, sharing: { freeMb: 6144, others: [], heavy: false } });
    assert.deepEqual([files.get(PATH), files.get(`${SHARED}/t1.json`), await lineOf(files)], [undefined, storedText(share), []]);
  });

  it('keeps a lone small step waiting while free memory is under the floor plus its own MB (T2192)', async () => {
    const { files, lock } = world({}, undefined, new FakeHostMemory(6143));
    const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL });
    assert.deepEqual(taking, { kind: 'busy', holder: { kind: 'memory', freeMb: 6143, heldMb: 0, needMb: 6144, floorMb: 4096, reserveMb: 2048, shares: [] } });
    assert.deepEqual([await files.list(SHARED), await lineOf(files)], [[], []]);
  });

  it('lets another small step in while the free memory less the MB held for the others leaves the floor and its own', async () => {
    const [path, text] = shareFile(shareOf());
    const { lock } = world({ [path]: text }, undefined, new FakeHostMemory(8192));
    const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL });
    assert.deepEqual(taking.kind === 'taken' ? taking.sharing : undefined, { freeMb: 8192, others: [shareOf()], heavy: false });
  });

  it('keeps a small step waiting while memory is short, telling of it once, and lets it in when the share ends', async () => {
    const [path, text] = shareFile(shareOf());
    let sleeps = 0;
    const { clock, lock } = world(
      { [path]: text },
      (time, store) => async (ms) => {
        await time.sleep(ms);
        sleeps += 1;
        if (sleeps === 2) {
          await store.remove(path);
        }
      },
      new FakeHostMemory(8191),
    );
    const told: string[] = [];
    const taking = await lock.acquire('alpha', 'heavy: specs', 60_000, 30_000, (holder, ahead) => told.push(waitText(holder, ahead, TimeZone.UTC)), { need: SMALL });
    assert.deepEqual(told, ['1 small step: po (heavy: specs) since 2030-01-08 09:50 UTC; host memory: 8191 MB free, 2048 MB held for it, 6144 MB needed (4096 floor + 2048 for this step)']);
    assert.deepEqual(clock.sleeps, [FIRST_IN_LINE_POLL_MS, FIRST_IN_LINE_POLL_MS]);
    assert.deepEqual(taking.kind === 'taken' ? taking.sharing : undefined, { freeMb: 8191, others: [], heavy: false });
  });

  it('gives up when memory stays short through its wait, writing no share', async () => {
    const [path, text] = shareFile(shareOf());
    const { files, lock } = world({ [path]: text }, undefined, new FakeHostMemory(100));
    const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL });
    assert.equal(taking.kind === 'busy' ? taking.holder.kind : '', 'memory');
    assert.deepEqual([await files.list(SHARED), await lineOf(files)], [['other.json'], []]);
  });

  it('never shares a host whose lock is held, nor ahead of an earlier waiter', async () => {
    const held = world({ [PATH]: heldBy() });
    const busy = await held.lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL });
    const [early, text] = ticket(waiterOf('2030-01-08T09:59:00.000Z'));
    const queued = world({ [early]: text });
    const behind = await queued.lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL });
    assert.deepEqual([busy.kind === 'busy' ? busy.holder.kind : '', behind.kind === 'busy' ? behind.holder.kind : ''], ['held', 'queued']);
    assert.deepEqual([await held.files.list(SHARED), await queued.files.list(SHARED)], [[], []]);
  });

  it('shares a host whose lock is stale, leaving that lock for the next step that takes the lock', async () => {
    const { files, lock } = world({ [PATH]: heldBy({ pid: 7 }) }, undefined, new FakeHostMemory(16_000));
    const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL });
    assert.equal(taking.kind === 'taken' ? taking.sharing?.freeMb : undefined, 16_000);
    assert.equal(files.get(PATH), heldBy({ pid: 7 }));
  });

  it('removes a file it cannot read once it has seen it so for 10 seconds, then shares the host', async () => {
    const { clock, files, lock } = world({ [PATH]: '{"tok' }, undefined, new FakeHostMemory(16_000));
    const taking = await lock.acquire('alpha', 'heavy: specs', 60_000, 30_000, () => undefined, { need: SMALL });
    assert.equal(taking.kind === 'taken' ? taking.sharing?.freeMb : undefined, 16_000);
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
    const memory: LockWait = { kind: 'memory', freeMb: 7000, heldMb: 4096, needMb: 6144, floorMb: 4096, reserveMb: 2048, shares };
    const memoryText = `${steps}; host memory: 7000 MB free, 4096 MB held for them, 6144 MB needed (4096 floor + 2048 for this step)`;
    assert.equal(holderText(memory, TimeZone.UTC), memoryText);
    const commit: LockWait = { kind: 'commit', usedMb: 30_000, limitMb: 32_000, maxPct: 92, reserveMb: 4096, shares: [] };
    const commitText = 'host commit charge: 30000 of 32000 MB, 4096 MB more for this step would pass 92% (open.headroom.commitMaxPct)';
    assert.equal(holderText(commit, TimeZone.UTC), commitText);
    const holder = shareOf({ id: 'h', purpose: 'heavy: build', kit: '0.1.0' });
    const heldText = `po (heavy: build) since 2030-01-08 09:50 UTC, on teamrig 0.1.0, waiting for ${steps}`;
    assert.equal(holderText({ kind: 'held', info: holder, waitsFor: shares }, TimeZone.UTC), heldText);
    assert.deepEqual(
      [busyText(memory, TimeZone.UTC), busyText(commit, TimeZone.UTC), busyText({ kind: 'held', info: holder, waitsFor: shares }, TimeZone.UTC)],
      [`host memory still short: ${memoryText}`, `host memory still short: ${commitText}`, `host lock still held by ${heldText}`],
    );
  });

  it('names the small steps a holder still waits for, to a step and to a small step waiting behind it', async () => {
    const info: HostLockInfo = { id: 'other', pid: OTHER, session: 'po', purpose: 'heavy: build', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:50:00.000Z', expiresAt: '2030-01-08T12:20:00.000Z' };
    const web = shareOf({ id: 's1', session: 'web', acquiredAt: '2030-01-08T09:55:00.000Z' });
    const initial = Object.fromEntries([[PATH, storedText(info)], shareFile(web), shareFile(shareOf({ id: 'gone', pid: 7 }))]);
    const told: string[] = [];
    const step = await world(initial).lock.acquire('alpha', 'heavy: build', 0, 30_000, (holder) => told.push(holderText(holder, TimeZone.UTC)));
    const smallStep = await world(initial).lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL });
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

describe('HostLock memory gate (T2192)', () => {
  it('keeps a step first in line while free memory is short, telling of it once, and lets no later step pass it', async () => {
    const later: Taking[] = [];
    const { clock, files, lock } = world(
      {},
      (time, store) => async (ms) => {
        await time.sleep(ms);
        if (later.length === 0) {
          later.push(await lockOver(store, time, OTHER).acquire('bravo', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL }));
        }
      },
      new FakeHostMemory(9000).readsFree(5000),
    );
    const told: string[] = [];
    const taking = await lock.acquire('alpha', 'heavy: build', 60_000, 30_000, (holder, ahead) => told.push(waitText(holder, ahead, TimeZone.UTC)));
    assert.deepEqual(told, ['host memory: 5000 MB free, 8192 MB needed (4096 floor + 4096 for this step)']);
    const laterKinds = later.map((step) => (step.kind === 'busy' ? step.holder.kind : step.kind));
    assert.deepEqual([clock.sleeps, taking.kind, laterKinds], [[FIRST_IN_LINE_POLL_MS], 'taken', ['queued']]);
    assert.deepEqual(await files.list(SHARED), [], 'the later small step wrote no share');
  });

  it('holds the MB a step asks for, more than the heavy reserve, and takes no lock while it is short', async () => {
    const { files, lock } = world({}, undefined, new FakeHostMemory(10_000));
    const need: StepNeed = { shares: false, reserveMb: 6000 };
    const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined, { need });
    assert.deepEqual(taking, { kind: 'busy', holder: { kind: 'memory', freeMb: 10_000, heldMb: 0, needMb: 10_096, floorMb: 4096, reserveMb: 6000, shares: [] } });
    assert.equal(files.get(PATH), undefined);
  });

  it('counts the MB held for the small steps sharing the host as taken when a step would take the lock', async () => {
    const [path, text] = shareFile(shareOf());
    const { files, lock } = world({ [path]: text }, undefined, new FakeHostMemory(10_000));
    const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined);
    assert.deepEqual(taking, { kind: 'busy', holder: { kind: 'memory', freeMb: 10_000, heldMb: 2048, needMb: 8192, floorMb: 4096, reserveMb: 4096, shares: [shareOf()] } });
    assert.deepEqual([files.get(PATH), files.get(path)], [undefined, text]);
  });

  it('waits while the commit charge with the step counted would pass its limit, though free memory has room', async () => {
    const { files, lock } = world({}, undefined, new FakeHostMemory(16_000).lists([], { usedMb: 28_000, limitMb: 32_000 }));
    const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined);
    assert.deepEqual(taking, { kind: 'busy', holder: { kind: 'commit', usedMb: 28_000, limitMb: 32_000, maxPct: 92, reserveMb: 4096, shares: [] } });
    assert.equal(files.get(PATH), undefined);
  });

  it('names a live holder or an unreadable lock before the memory, however short', async () => {
    const kinds: string[] = [];
    for (const initial of [{ [PATH]: heldBy() }, { [PATH]: '{"tok' }]) {
      for (const ask of [{}, { need: SMALL }]) {
        const taking = await world(initial, undefined, new FakeHostMemory(100)).lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined, ask);
        kinds.push(taking.kind === 'busy' ? taking.holder.kind : taking.kind);
      }
    }
    assert.deepEqual(kinds, ['held', 'held', 'unknown', 'unknown']);
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
    assert.equal((await sharing.lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL })).kind, 'taken');
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

/** Files in memory that count the writes to each path. */
class Counting extends MemoryFiles {
  readonly writes = new Map<string, number>();

  override async write(path: string, text: string): Promise<void> {
    this.writes.set(path, (this.writes.get(path) ?? 0) + 1);
    await super.write(path, text);
  }

  /** The writes to the tickets in the line, one count per ticket; a path may be joined with either slash, as on Windows. */
  ticketWrites(): number[] {
    return [...this.writes.entries()].filter(([path]) => path.replaceAll('\\', '/').startsWith(`${QUEUE}/`)).map(([, count]) => count);
  }
}

/** This step's ticket (`t1`) as a reader of the line finds it at `clock`'s time: when its wait runs out, and what it waits on. */
async function mineOf(store: Files, clock: FakeClock): Promise<Pick<LockWaiter, 'expiresAt' | 'waitingOn'> | undefined> {
  const mine = (await lockOver(store, clock, 77).line()).find((waiter) => waiter.id === 't1');
  return mine === undefined ? undefined : { expiresAt: mine.expiresAt, ...(mine.waitingOn === undefined ? {} : { waitingOn: mine.waitingOn }) };
}

/** What this step's ticket says it waits on, as a reader of the line finds it at `clock`'s time. */
async function waitingOnOf(store: Files, clock: FakeClock): Promise<WaitingOn | undefined> {
  return (await mineOf(store, clock))?.waitingOn;
}

/** `seen` without an entry equal to the one before it. */
function changesOf<T>(seen: readonly T[]): T[] {
  return seen.filter((entry, at) => at === 0 || JSON.stringify(entry) !== JSON.stringify(seen[at - 1]));
}

describe('HostLock waitingOn: what a waiter says it waits on (T2209)', () => {
  it('says on its ticket from its first look the report the step hears, on the team clock, since that look', async () => {
    const seen: (WaitingOn | undefined)[] = [];
    const { lock } = world({ [PATH]: heldBy() }, (time, store) => async (ms) => {
      seen.push(await waitingOnOf(store, time));
      await time.sleep(ms);
    });
    const told: string[] = [];
    await lock.acquire('alpha', 'heavy: test', 4_000, 30_000, (holder, ahead) => told.push(waitText(holder, ahead, JERUSALEM)));
    assert.deepEqual(seen, [HELD_BY_PO, HELD_BY_PO]);
    assert.deepEqual(told, [HELD_BY_PO.text]);
  });

  it('keeps its since through a new holder of the same cause, and moves it when the cause changes', async () => {
    const memory = new FakeHostMemory(5000);
    const seen: (WaitingOn | undefined)[] = [];
    let sleeps = 0;
    const { lock } = world(
      { [PATH]: heldBy() },
      (time, store) => async (ms) => {
        seen.push(await waitingOnOf(store, time));
        await time.sleep(ms);
        sleeps += 1;
        if (sleeps === 1) {
          await store.write(PATH, heldBy({ id: 'third', session: 'bravo' }));
        } else if (sleeps === 2) {
          await store.remove(PATH);
        } else {
          memory.free = 16_000;
        }
      },
      memory,
    );
    const taking = await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined);
    assert.equal(taking.kind, 'taken');
    assert.deepEqual(seen, [
      HELD_BY_PO,
      { ...HELD_BY_PO, text: 'bravo (heavy: build) since 2030-01-08 11:50 IST' },
      { reason: 'memory', text: 'host memory: 5000 MB free, 8192 MB needed (4096 floor + 4096 for this step)', since: '2030-01-08T10:00:04.000Z' },
    ]);
  });

  it('writes its ticket again only when its report changes, as the line misses it for a moment at each write', async () => {
    const clock = new FakeClock('2030-01-08T10:00:00Z');
    const files = new Counting({ [PATH]: heldBy() });
    const texts = new Set<string>();
    const sleep: Sleep = async (ms) => {
      for (const name of await files.list(QUEUE)) {
        texts.add(files.get(`${QUEUE}/${name}`) ?? '');
      }
      await clock.sleep(ms);
    };
    const taking = await lockOver(files, clock, ME, sleep).acquire('alpha', 'heavy: test', 10_000, 30_000, () => undefined);
    assert.deepEqual([taking.kind, clock.sleeps.length, texts.size], ['busy', 5, 1], 'one text through its five looks');
    assert.deepEqual(files.ticketWrites(), [2], 'written as it joined the line, then once with its first report');
  });

  it('writes its ticket once when its line moves and its report changes at the same look', async () => {
    const [early, text] = ticket(waiterOf('2030-01-08T09:58:00.000Z', { id: 'early' }));
    const clock = new FakeClock('2030-01-08T10:00:00Z');
    const files = new Counting({ [PATH]: heldBy(), [early]: text });
    const seen: unknown[] = [];
    let sleeps = 0;
    const sleep: Sleep = async (ms) => {
      seen.push(await mineOf(files, clock));
      await clock.sleep(ms);
      sleeps += 1;
      if (sleeps === 1) {
        await files.remove(early);
      }
    };
    const taking = await lockOver(files, clock, ME, sleep).acquire('alpha', 'heavy: test', 30_000, 30_000, () => undefined);
    assert.equal(taking.kind, 'busy');
    assert.deepEqual(changesOf(seen), [
      { expiresAt: '2030-01-08T10:00:40.000Z', waitingOn: { ...HELD_BY_PO, text: `${HELD_BY_PO.text}; 1 ahead in line` } },
      { expiresAt: '2030-01-08T10:01:10.000Z', waitingOn: HELD_BY_PO },
    ]);
    assert.deepEqual(files.ticketWrites(), [3],'joining, its first report, then the move with its new report in one write');
  });

  it('keeps what it waits on when its line moves with no new report, its wait running out later', async () => {
    const [first, firstText] = ticket(waiterOf('2030-01-08T09:58:00.000Z', { id: 'e1' }));
    const [earlier, earlierText] = ticket(waiterOf('2030-01-08T09:57:00.000Z', { id: 'e0' }));
    const seen: unknown[] = [];
    let sleeps = 0;
    const { lock } = world({ [PATH]: heldBy(), [first]: firstText }, (time, store) => async (ms) => {
      seen.push(await mineOf(store, time));
      await time.sleep(ms);
      sleeps += 1;
      if (sleeps === 1) {
        await store.remove(first);
        await store.write(earlier, earlierText);
      }
    });
    await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined);
    const waitingOn: WaitingOn = { ...HELD_BY_PO, text: `${HELD_BY_PO.text}; 1 ahead in line` };
    assert.deepEqual(changesOf(seen), [
      { expiresAt: '2030-01-08T10:01:10.000Z', waitingOn },
      { expiresAt: '2030-01-08T10:01:40.000Z', waitingOn },
    ]);
  });

  it("keeps in line a ticket whose waitingOn this teamrig cannot read, as a later kit's cause, leaving that field out", async () => {
    const known = waiterOf('2030-01-08T09:58:00.000Z', { id: 'known', waitingOn: HELD_BY_PO });
    const later = waiterOf('2030-01-08T09:59:00.000Z');
    const [path] = ticket(later);
    const text = JSON.stringify({ ...onDisk(later), waitingOn: { reason: 'cpu', text: 'host CPU busy', since: '2030-01-08T09:59:00.000Z' } });
    const { files, lock } = world(Object.fromEntries([ticket(known), [path, text]]));
    const told: number[] = [];
    const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, (_holder, ahead) => told.push(ahead));
    assert.deepEqual([taking.kind, told], ['busy', [2]], 'a step behind it still counts it ahead');
    assert.deepEqual(await lock.line(), [known, later]);
    assert.equal(files.get(path), text, 'its ticket is left as it was');
  });

  it('never writes back a ticket withdrawn before its first report, and stops at once', async () => {
    const clock = new FakeClock('2030-01-08T10:00:00Z');
    let done: Withdrawal[] = [];
    const files = new Interleaved({ [PATH]: heldBy() }, 'read', (path) => path === PATH, async (store) => {
      done = await lockOver(store, clock, 77).withdraw('alpha', () => true);
    });
    const taking = await lockOver(files, clock).acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined);
    assert.deepEqual([taking, done.map((withdrawal) => withdrawal.kind), clock.sleeps, await lineOf(files)], [{ kind: 'withdrawn' }, ['withdrawn'], [], []]);
  });

  it('says it waits on the small steps ending while it holds the lock for them', async () => {
    const [path, text] = shareFile(shareOf());
    const seen: (WaitingOn | undefined)[] = [];
    let sleeps = 0;
    const { lock } = world({ [path]: text }, (time, store) => async (ms) => {
      seen.push(await waitingOnOf(store, time));
      await time.sleep(ms);
      sleeps += 1;
      if (sleeps === 2) {
        await store.remove(path);
      }
    });
    const taking = await lock.acquire('alpha', 'heavy: build', 60 * 60_000, 30_000, () => undefined);
    const draining: WaitingOn = { reason: 'draining', text: '1 small step: po (heavy: specs) since 2030-01-08 11:50 IST', since: '2030-01-08T10:00:00.000Z' };
    assert.deepEqual([taking.kind, seen], ['taken', [draining, draining]]);
  });
});

/** What alpha's step asks: tests for T7, a p1 Maintenance task, Maintenance planned at a quarter of the week. */
const REQUEST: LineRequest = { kind: 'test', task: 'T7', priority: 1, class: 'Maintenance', classPct: 25 };

/** What this step's ticket (`t1`) says it asks, as a reader of the line finds it at `clock`'s time. */
async function requestOf(store: Files, clock: FakeClock): Promise<TicketRequest | undefined> {
  return (await lockOver(store, clock, 77).line()).find((waiter) => waiter.id === 't1')?.request;
}

describe("HostLock tickets and shares: what the step asks (T2210)", () => {
  for (const [label, need, memory, held] of [
    ['a small step: the MB its need holds, sharing the host', SMALL, undefined, { needMb: 2048, heavy: false, exclusive: false }],
    ["a step with no need: the memory gate's heavy reserve, the whole host", undefined, new FakeHostMemory(16_000), { needMb: 4096, heavy: true, exclusive: true }],
    ['a step with no need on a lock with no memory gate: no MB, the whole host', undefined, undefined, { needMb: 0, heavy: true, exclusive: true }],
  ] as const) {
    it(`says on its ticket while it waits what it asks, for ${label}`, async () => {
      const seen: (TicketRequest | undefined)[] = [];
      const { lock } = world(
        { [PATH]: heldBy() },
        (time, store) => async (ms) => {
          seen.push(await requestOf(store, time));
          await time.sleep(ms);
        },
        memory,
      );
      const taking = await lock.acquire('alpha', 'heavy: test', 2_000, 30_000, () => undefined, { ...(need === undefined ? {} : { need }), request: REQUEST });
      assert.deepEqual([taking.kind, seen], ['busy', [{ ...REQUEST, ...held }]]);
    });
  }

  it('writes no request on the ticket of a step that names none', async () => {
    const seen: (TicketRequest | undefined)[] = [];
    const { lock } = world({ [PATH]: heldBy() }, (time, store) => async (ms) => {
      seen.push(await requestOf(store, time));
      await time.sleep(ms);
    });
    await lock.acquire('alpha', 'heavy: test', 2_000, 30_000, () => undefined, { need: SMALL });
    assert.deepEqual(seen, [undefined]);
  });

  it("copies its ticket's request onto the share it takes, beside the reserveMb an older kit reads", async () => {
    const { files, lock } = world({}, undefined, new FakeHostMemory(6144));
    const taking = await lock.acquire('alpha', 'heavy: specs', 60_000, 30_000, () => undefined, { need: SMALL, request: REQUEST });
    const share = shareOf({ id: 't1', pid: ME, session: 'alpha', acquiredAt: '2030-01-08T10:00:00.000Z', expiresAt: '2030-01-08T12:30:00.000Z', request: { ...REQUEST, needMb: 2048, heavy: false, exclusive: false } });
    assert.deepEqual([taking.kind === 'taken' ? taking.lock : undefined, files.get(`${SHARED}/t1.json`), await lock.shares()], [share, storedText(share), [share]]);
  });

  it("keeps in line an older kit's ticket, which names no request, and one whose request this teamrig cannot read, leaving that field out", async () => {
    const older = waiterOf('2030-01-08T09:58:00.000Z', { id: 'older' });
    const later = waiterOf('2030-01-08T09:59:00.000Z');
    const [path] = ticket(later);
    const text = JSON.stringify({ ...onDisk(later), request: { ...REQUEST, kind: 'vm', needMb: 4096, heavy: true, exclusive: true } });
    const { files, lock } = world(Object.fromEntries([ticket(older), [path, text]]));
    const told: number[] = [];
    const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, (_holder, ahead) => told.push(ahead), { request: REQUEST });
    assert.deepEqual([taking.kind, told], ['busy', [2]], 'a step behind them still counts both ahead');
    assert.deepEqual(await lock.line(), [older, later]);
    assert.equal(files.get(path), text, 'its ticket is left as it was');
  });

  it("counts the MB of an older kit's share, which names no request, and of one whose request this teamrig cannot read, leaving that field out", async () => {
    const older = shareOf();
    const later = shareOf({ id: 'later', acquiredAt: '2030-01-08T09:55:00.000Z' });
    const [path] = shareFile(later);
    const text = JSON.stringify({ ...onDisk(later), request: { ...REQUEST, classPct: 'x', needMb: 2048, heavy: false, exclusive: false } });
    const { files, lock } = world(Object.fromEntries([shareFile(older), [path, text]]), undefined, new FakeHostMemory(10_240));
    const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL, request: REQUEST });
    assert.deepEqual(taking.kind === 'taken' ? taking.sharing : undefined, { freeMb: 10_240, others: [older, later], heavy: false }, 'the floor, both shares and its own MB fit');
    assert.equal(files.get(path), text, 'its share is left as it was');
  });
});

/** Admission in `pipeline` mode, as the config defaults set it: 15 minutes a priority step, two steps a session. */
const PIPELINE: AdmissionRules = { mode: 'pipeline', agingMinutes: 15, perSessionRunning: 2, maxHeavyParallel: 2, defaultClass: 'Improvements' };

const ADMIT = `${PATH}.admit`;

/** Bravo's ticket from 09:59, a heavy step at `priority` in REQUEST's class. */
function bravoAt(priority: number): [string, string] {
  return ticket(waiterOf('2030-01-08T09:59:00.000Z', { request: { ...REQUEST, priority, needMb: 0, heavy: true, exclusive: false } }));
}

/** Two small steps of `session` sharing the host since 09:50 and 09:55. */
function sharesOf(session: string): HostShare[] {
  return [shareOf({ id: 's1', session }), shareOf({ id: 's2', session, acquiredAt: '2030-01-08T09:55:00.000Z' })];
}

describe('HostLock admission (T2210)', () => {
  it("takes a free lock before an earlier waiter of a later priority, leaving that ticket and no admit file", async () => {
    const [early, text] = bravoAt(3);
    const { files, lock } = world({ [early]: text }, undefined, undefined, PIPELINE);
    const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: REQUEST });
    assert.equal(taking.kind, 'taken');
    assert.deepEqual([files.get(early), files.get(ADMIT)], [text, undefined]);
  });

  it("passes an older kit's ticket, which names no request and so counts at p2, only at an earlier priority", async () => {
    const older = waiterOf('2030-01-08T09:59:00.000Z', { id: 'older' });
    const results: string[] = [];
    for (const priority of [1, 3]) {
      const { lock } = world(Object.fromEntries([ticket(older)]), undefined, undefined, PIPELINE);
      const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: { ...REQUEST, priority } });
      results.push(taking.kind === 'busy' && taking.holder.kind === 'queued' ? `queued behind ${taking.holder.first.id}` : taking.kind);
    }
    assert.deepEqual(results, ['taken', 'queued behind older']);
  });

  for (const [label, admission] of [
    ['serial rules', { ...PIPELINE, mode: 'serial' }],
    ['no rules', undefined],
  ] as const) {
    it(`keeps arrival order with ${label}: an earlier waiter of a later priority stays ahead`, async () => {
      const [early] = bravoAt(3);
      const { files, lock } = world(Object.fromEntries([bravoAt(3)]), undefined, undefined, admission);
      const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: REQUEST });
      assert.equal(taking.kind === 'busy' && taking.holder.kind === 'queued' ? taking.holder.first.id : taking.kind, 'bravo');
      assert.deepEqual([files.get(PATH), files.get(ADMIT), await lineOf(files)], [undefined, undefined, [early.slice(QUEUE.length + 1)]]);
    });
  }

  it("passes an earlier waiter whose session runs its cap of steps, and shares the host beside them; serial rules keep it waiting", async () => {
    const running = sharesOf('bravo');
    const initial = Object.fromEntries([...running.map((share) => shareFile(share)), bravoAt(1)]);
    const results: unknown[] = [];
    for (const admission of [PIPELINE, { ...PIPELINE, mode: 'serial' } as const]) {
      const { lock } = world(initial, undefined, new FakeHostMemory(10_240), admission);
      const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL, request: { ...REQUEST, priority: 3 } });
      results.push(taking.kind === 'busy' ? taking.holder.kind : taking);
    }
    const share = shareOf({ id: 't1', pid: ME, session: 'alpha', acquiredAt: '2030-01-08T10:00:00.000Z', expiresAt: '2030-01-08T12:30:00.000Z', request: { ...REQUEST, priority: 3, needMb: 2048, heavy: false, exclusive: false } });
    assert.deepEqual(results, [{ kind: 'taken', lock: share, sharing: { freeMb: 10_240, others: running, heavy: false } }, 'queued']);
  });

  it('waits while its own session runs its cap of steps, the lock its holder takes counted, naming them', async () => {
    const shares = sharesOf('alpha');
    const holder = infoOf({ session: 'alpha' });
    const [first] = shares;
    assert.ok(first !== undefined);
    const results: unknown[] = [];
    const told: string[] = [];
    for (const initial of [Object.fromEntries(shares.map((share) => shareFile(share))), Object.fromEntries([[PATH, heldBy({ session: 'alpha' })], shareFile(first)])]) {
      const { files, lock } = world(initial, undefined, new FakeHostMemory(16_000), PIPELINE);
      const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, (wait, ahead) => told.push(waitText(wait, ahead, TimeZone.UTC)), { need: SMALL, request: REQUEST });
      results.push(taking, (await files.list(SHARED)).length, await lineOf(files));
    }
    assert.deepEqual(results, [
      { kind: 'busy', holder: { kind: 'sessionCap', cap: 2, running: shares } },
      2,
      [],
      { kind: 'busy', holder: { kind: 'sessionCap', cap: 2, running: [holder, first] } },
      1,
      [],
    ]);
    assert.deepEqual(told, [
      '2 steps of its session running, its cap 2: alpha (heavy: specs) since 2030-01-08 09:50 UTC, alpha (heavy: specs) since 2030-01-08 09:55 UTC',
      '2 steps of its session running, its cap 2: alpha (heavy: build) since 2030-01-08 09:50 UTC, alpha (heavy: specs) since 2030-01-08 09:50 UTC',
    ]);
  });

  it("says on its ticket that it waits on its session's cap", async () => {
    const seen: (WaitingOn | undefined)[] = [];
    const { lock } = world(
      Object.fromEntries(sharesOf('alpha').map((share) => shareFile(share))),
      (time, store) => async (ms) => {
        seen.push(await waitingOnOf(store, time));
        await time.sleep(ms);
      },
      new FakeHostMemory(16_000),
      PIPELINE,
    );
    await lock.acquire('alpha', 'heavy: specs', 2_000, 30_000, () => undefined, { need: SMALL, request: REQUEST });
    assert.deepEqual(seen, [
      {
        reason: 'session',
        text: '2 steps of its session running, its cap 2: alpha (heavy: specs) since 2030-01-08 11:50 IST, alpha (heavy: specs) since 2030-01-08 11:55 IST',
        since: '2030-01-08T10:00:00.000Z',
      },
    ]);
  });

  it('sets no cap at perSessionRunning 0: a session sharing the host twice shares it a third time', async () => {
    const shares = sharesOf('alpha');
    const { lock } = world(Object.fromEntries(shares.map((share) => shareFile(share))), undefined, new FakeHostMemory(16_000), { ...PIPELINE, perSessionRunning: 0 });
    const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL, request: REQUEST });
    assert.deepEqual(taking.kind === 'taken' ? taking.sharing : undefined, { freeMb: 16_000, others: shares, heavy: false });
  });

  it("waits while another live step's claim holds the admit file, taking nothing and leaving the claim", async () => {
    const claim = JSON.stringify({ ticket: 'bravo', pid: OTHER, expiresAt: '2030-01-08T10:00:20.000Z' });
    const { files, lock } = world({ [ADMIT]: claim }, undefined, undefined, PIPELINE);
    const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: REQUEST });
    assert.deepEqual([taking, files.get(PATH), files.get(ADMIT)], [{ kind: 'busy', holder: { kind: 'admitting' } }, undefined, claim]);
  });

  it('takes its turn once a live claim on the admit file runs out, looking every 2 s meanwhile', async () => {
    const claim = JSON.stringify({ ticket: 'bravo', pid: OTHER, expiresAt: '2030-01-08T10:00:30.000Z' });
    const { clock, files, lock } = world({ [ADMIT]: claim }, undefined, undefined, PIPELINE);
    const taking = await lock.acquire('alpha', 'heavy: test', 60_000, 30_000, () => undefined, { request: REQUEST });
    assert.deepEqual([taking.kind, files.get(ADMIT)], ['taken', undefined]);
    assert.deepEqual(clock.sleeps, Array.from({ length: 15 }, () => FIRST_IN_LINE_POLL_MS));
  });

  for (const [label, claim] of [
    ['whose process is gone', JSON.stringify({ ticket: 'bravo', pid: 7, expiresAt: '2030-01-08T10:00:20.000Z' })],
    ['that ran out', JSON.stringify({ ticket: 'bravo', pid: OTHER, expiresAt: '2030-01-08T10:00:00.000Z' })],
    ['that cannot be read', '{"tick'],
  ] as const) {
    it(`removes a claim on the admit file ${label} and takes its turn at once`, async () => {
      const { clock, files, lock } = world({ [ADMIT]: claim }, undefined, undefined, PIPELINE);
      const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: REQUEST });
      assert.deepEqual([taking.kind, files.get(ADMIT), clock.sleeps], ['taken', undefined, []]);
    });
  }

  it('claims the admit file for 30 s and looks at the line again under it: an urgent step that joined meanwhile goes first', async () => {
    const urgent = waiterOf('2030-01-08T10:00:00.000Z', { id: 'urgent', request: { ...REQUEST, priority: 0, needMb: 0, heavy: true, exclusive: false } });
    const [path, text] = ticket(urgent);
    const claims: unknown[] = [];
    const files = new Interleaved({}, 'createExclusive', (at) => at.replaceAll('\\', '/') === ADMIT, async (store) => {
      claims.push(JSON.parse(store.get(ADMIT) ?? 'null'));
      await store.write(path, text);
    });
    const clock = new FakeClock('2030-01-08T10:00:00Z');
    const taking = await lockOver(files, clock, ME, clock.sleep, PIPELINE).acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: REQUEST });
    assert.deepEqual(claims, [{ ticket: 't1', pid: ME, expiresAt: '2030-01-08T10:00:30.000Z' }]);
    assert.deepEqual([taking, files.get(PATH), files.get(ADMIT), await lineOf(files)], [{ kind: 'busy', holder: { kind: 'queued', first: urgent } }, undefined, undefined, [path.slice(QUEUE.length + 1)]]);
  });

  it("names its session's steps running at its cap, and another step being admitted", () => {
    const capped: LockWait = { kind: 'sessionCap', cap: 2, running: [infoOf({ session: 'alpha' }), shareOf({ id: 's1', session: 'alpha', acquiredAt: '2030-01-08T09:55:00.000Z' })] };
    const steps = '2 steps of its session running, its cap 2: alpha (heavy: build) since 2030-01-08 09:50 UTC, alpha (heavy: specs) since 2030-01-08 09:55 UTC';
    const one: LockWait = { kind: 'sessionCap', cap: 1, running: [infoOf({ session: 'alpha' })] };
    const admitting: LockWait = { kind: 'admitting' };
    assert.deepEqual(
      [holderText(capped, TimeZone.UTC), busyText(capped, TimeZone.UTC), waitText(capped, 1, TimeZone.UTC), holderText(one, JERUSALEM)],
      [steps, `session cap still reached: ${steps}`, `${steps}; 1 ahead in line`, '1 step of its session running, its cap 1: alpha (heavy: build) since 2030-01-08 11:50 IST'],
    );
    assert.deepEqual(
      [holderText(admitting, TimeZone.UTC), busyText(admitting, TimeZone.UTC), waitText(admitting, 0, TimeZone.UTC)],
      ['another step being admitted', 'host lock still held by another step being admitted', 'another step being admitted'],
    );
  });
});

const TURNS = `${PATH}.turns.json`;
const ENDED = `${PATH}.ended`;

/** The turns file `[path, text]`: each class's virtual time, the open charges and the floor. */
function turnsFile(classes: Readonly<Record<string, number>>, open: readonly OpenCharge[] = [], floor: number = 0): [string, string] {
  return [TURNS, JSON.stringify({ v: 1, floor, classes, open })];
}

/** What the turns file says, read back; undefined when there is none. */
function turnsIn(files: MemoryFiles): unknown {
  const text = files.get(TURNS);
  return text === undefined ? undefined : JSON.parse(text);
}

/** The charge alpha's step `ticket` opened in REQUEST's class (Maintenance, 25%) when it was admitted at `at`. */
function maintenance(ticket: string, at: string = '2030-01-08T10:00:00.000Z'): OpenCharge {
  return { ticket, class: 'Maintenance', pct: 25, at, minutes: 5 };
}

describe('HostLock class turns (T2210)', () => {
  const roadmap: LineRequest = { ...REQUEST, class: 'Roadmap', classPct: 50 };

  it('lets the class with the least virtual time go first, past an earlier waiter at a more urgent priority', async () => {
    const results: string[] = [];
    const presets: Readonly<Record<string, string>>[] = [{}, Object.fromEntries([turnsFile({ Maintenance: 100, Roadmap: 10 })])];
    for (const preset of presets) {
      const { lock } = world({ ...Object.fromEntries([bravoAt(1)]), ...preset }, undefined, undefined, PIPELINE);
      const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: { ...roadmap, priority: 3 } });
      results.push(taking.kind === 'busy' && taking.holder.kind === 'queued' ? `queued behind ${taking.holder.first.id}` : taking.kind);
    }
    assert.deepEqual(results, ['queued behind bravo', 'taken'], "with no turns, priority decides; with turns, it is Roadmap's turn");
  });

  it('reads the line in admission order by the turns as they stand in pipeline mode, in arrival order in serial, writing nothing', async () => {
    const later = waiterOf('2030-01-08T09:59:30.000Z', { id: 'later', session: 'alpha', request: { ...roadmap, priority: 3, needMb: 0, heavy: true, exclusive: false } });
    const turns = turnsFile({ Maintenance: 100, Roadmap: 10 });
    const orders: string[][] = [];
    for (const admission of [PIPELINE, { ...PIPELINE, mode: 'serial' } as const]) {
      const { files, lock } = world(Object.fromEntries([bravoAt(1), ticket(later), turns]), undefined, undefined, admission);
      orders.push((await lock.line()).map(({ id }) => id));
      assert.deepEqual([files.get(turns[0]), files.get(ADMIT)], [turns[1], undefined]);
    }
    assert.deepEqual(orders, [['later', 'bravo'], ['bravo', 'later']], "pipeline: Roadmap's turn first; serial: bravo arrived first");
  });

  for (const [label, need, minutes, turn] of [
    ['the minutes its need expects', { shares: false, reserveMb: 0, expectedMinutes: 12 }, 12, 48],
    ['5 minutes when its need learned none', undefined, 5, 20],
  ] as const) {
    it(`charges the class of a step it admits ${label}, the charge kept open under its ticket's id`, async () => {
      const { files, lock } = world({}, undefined, undefined, PIPELINE);
      const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { ...(need === undefined ? {} : { need }), request: REQUEST });
      assert.equal(taking.kind, 'taken');
      assert.deepEqual(turnsIn(files), { v: 1, floor: 0, classes: { Maintenance: turn }, open: [{ ...maintenance('t1'), minutes }] }, `${minutes} minutes at 25% is ${turn}`);
    });
  }

  for (const [label, need, exclusive, held] of [
    ['its lock', undefined, true, PATH],
    ["a heavy step's share", undefined, false, `${SHARED}/t1.json`],
    ["a small step's share", SMALL, false, `${SHARED}/t1.json`],
  ] as const) {
    it(`marks a step's end before ${label} goes; the next admission corrects its charge to the minutes it ran and removes the mark`, async () => {
      const marks: (string | undefined)[] = [];
      const files = new Interleaved({}, 'remove', (at) => at.replaceAll('\\', '/') === held, async (store) => {
        marks.push(store.get(`${ENDED}/t1.json`));
      });
      const clock = new FakeClock('2030-01-08T10:00:00Z');
      const lock = lockOver(files, clock, ME, clock.sleep, PIPELINE);
      const ask = { ...(need === undefined ? {} : { need }), exclusive, request: REQUEST };
      const first = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, ask);
      assert.ok(first.kind === 'taken');
      clock.advance(30 * 60_000);
      assert.equal(await lock.release(first.lock), true);
      assert.deepEqual(marks, ['{"endedAt":"2030-01-08T10:30:00.000Z"}'], 'the mark is there once it is gone');
      const second = await lock.acquire('alpha', 'heavy: lint', 0, 30_000, () => undefined, ask);
      assert.equal(second.kind, 'taken');
      // 30 minutes run where 5 were charged at 25%: 20 + 100; then the second step's 5 minutes: 140.
      assert.deepEqual(turnsIn(files), { v: 1, floor: 120, classes: { Maintenance: 140 }, open: [maintenance('t2', '2030-01-08T10:30:00.000Z')] });
      assert.deepEqual(await files.list(ENDED), []);
    });
  }

  it("closes the charge of a step that died before marking its end, its estimate standing, and keeps a running step's charge open", async () => {
    const preset = turnsFile({ Maintenance: 20 }, [maintenance('gone', '2030-01-08T09:00:00.000Z')]);
    const dead = world(Object.fromEntries([preset]), undefined, undefined, PIPELINE);
    const taken = await dead.lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: REQUEST });
    const live = world(Object.fromEntries([preset, [PATH, heldBy({ id: 'gone' })]]), undefined, undefined, PIPELINE);
    const busy = await live.lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: REQUEST });
    assert.deepEqual([taken.kind, turnsIn(dead.files)], ['taken', { v: 1, floor: 20, classes: { Maintenance: 40 }, open: [maintenance('t1')] }]);
    assert.deepEqual([busy.kind, live.files.get(TURNS)], ['busy', preset[1]], 'the running step keeps its charge, and the file stays as it was');
  });

  it('lifts a class idle while others ran to the floor at an admission, but not a class whose step still runs', async () => {
    const running: OpenCharge = { ticket: 'other', class: 'Busy', pct: 10, at: '2030-01-08T09:50:00.000Z', minutes: 30 };
    const waiting = ticket(waiterOf('2030-01-08T09:59:00.000Z', { request: { ...roadmap, needMb: 0, heavy: true, exclusive: false } }));
    const initial = Object.fromEntries([turnsFile({ Maintenance: 10, Roadmap: 50, Idle: 0, Busy: 0 }, [running]), shareFile(shareOf()), waiting]);
    const { files, lock } = world(initial, undefined, new FakeHostMemory(16_000), PIPELINE);
    const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL, request: REQUEST });
    assert.equal(taking.kind, 'taken', "Maintenance's 10 is under the waiting Roadmap's 50");
    assert.deepEqual(turnsIn(files), { v: 1, floor: 10, classes: { Maintenance: 30, Roadmap: 50, Idle: 10, Busy: 0 }, open: [running, maintenance('t1')] });
  });

  it('reads a damaged turns file as no turns, so priority orders the line, and writes the file whole at the admission', async () => {
    const { files, lock } = world(Object.fromEntries([bravoAt(3), [TURNS, '{"floor":']]), undefined, undefined, PIPELINE);
    const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: roadmap });
    assert.equal(taking.kind, 'taken', 'its p1 passes the p3 waiter');
    assert.deepEqual(turnsIn(files), { v: 1, floor: 0, classes: { Roadmap: 10 }, open: [{ ticket: 't1', class: 'Roadmap', pct: 50, at: '2030-01-08T10:00:00.000Z', minutes: 5 }] });
  });

  it('keeps a turns file a newer teamrig wrote as it is, its end marks too, and orders the line by priority', async () => {
    // Read, these turns would give the earlier p3 Maintenance waiter its class's turn before alpha's Roadmap step.
    const newer = '{"v":2,"floor":0,"classes":{"Maintenance":0,"Roadmap":100},"open":[],"weights":{}}';
    const mark = `${ENDED}/gone.json`;
    const { files, lock } = world(Object.fromEntries([bravoAt(3), [TURNS, newer], [mark, '{"endedAt":"2030-01-08T09:30:00.000Z"}']]), undefined, undefined, PIPELINE);
    const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: roadmap });
    assert.ok(taking.kind === 'taken', 'its p1 passes the p3 waiter');
    assert.equal(await lock.release(taking.lock), true);
    assert.deepEqual([files.get(TURNS), await files.list(ENDED)], [newer, ['gone.json']]);
  });

  it("counts an older kit's ticket, which names no request, in the default class", async () => {
    const older = waiterOf('2030-01-08T09:59:00.000Z', { id: 'older' });
    const results: string[] = [];
    for (const classes of [{ Improvements: 100, Maintenance: 10 }, { Improvements: 10, Maintenance: 100 }]) {
      const { lock } = world(Object.fromEntries([ticket(older), turnsFile(classes)]), undefined, undefined, PIPELINE);
      const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, { request: { ...REQUEST, priority: 3 } });
      results.push(taking.kind === 'busy' && taking.holder.kind === 'queued' ? `queued behind ${taking.holder.first.id}` : taking.kind);
    }
    assert.deepEqual(results, ['taken', 'queued behind older']);
  });

  for (const [label, admission, ask] of [
    ['serial rules', { ...PIPELINE, mode: 'serial' }, { request: REQUEST }],
    ['a step that names no request', PIPELINE, {}],
  ] as const) {
    it(`writes no turns file and marks no end for ${label}`, async () => {
      const { files, lock } = world({}, undefined, undefined, admission);
      const taking = await lock.acquire('alpha', 'heavy: test', 0, 30_000, () => undefined, ask);
      assert.ok(taking.kind === 'taken');
      assert.equal(await lock.release(taking.lock), true);
      assert.deepEqual([files.get(TURNS), await files.list(ENDED)], [undefined, []]);
    });
  }
});

/** A heavy step sharing the host in `pipeline` mode: po's build since 09:50, lasting to 12:20, by `OTHER`, 4096 MB held for it. */
function heavyOf(overrides: Partial<HostShare> = {}): HostShare {
  return shareOf({ purpose: 'heavy: build', reserveMb: 4096, heavy: true, ...overrides });
}

/** Web's heavy step, sharing the host since 09:55. */
const WEB_HEAVY = heavyOf({ id: 'h2', session: 'web', acquiredAt: '2030-01-08T09:55:00.000Z' });

describe('HostLock heavy shares (T2210)', () => {
  it('lets a second heavy step share the host in pipeline mode, writing its share marked heavy and leaving the lock file free', async () => {
    const running = heavyOf();
    const { files, lock } = world(Object.fromEntries([shareFile(running)]), undefined, new FakeHostMemory(16_000), PIPELINE);
    const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined, { request: REQUEST });
    const request = { ...REQUEST, needMb: 4096, heavy: true, exclusive: false };
    const share = heavyOf({ id: 't1', pid: ME, session: 'alpha', acquiredAt: '2030-01-08T10:00:00.000Z', expiresAt: '2030-01-08T12:30:00.000Z', request });
    assert.deepEqual(taking, { kind: 'taken', lock: share, sharing: { freeMb: 16_000, others: [running], heavy: true } });
    assert.deepEqual([files.get(PATH), files.get(`${SHARED}/t1.json`), await lineOf(files)], [undefined, storedText(share), []]);
  });

  it('keeps a heavy step waiting while the heavy steps run at their cap, naming them on its ticket, and lets it in when one ends', async () => {
    const first = heavyOf({ id: 'h1' });
    const seen: (WaitingOn | undefined)[] = [];
    const { clock, lock } = world(
      Object.fromEntries([shareFile(first), shareFile(WEB_HEAVY)]),
      (time, store) => async (ms) => {
        seen.push(await waitingOnOf(store, time));
        await time.sleep(ms);
        await store.remove(shareFile(first)[0]);
      },
      undefined,
      PIPELINE,
    );
    const told: string[] = [];
    const taking = await lock.acquire('alpha', 'heavy: build', 60_000, 30_000, (holder, ahead) => told.push(waitText(holder, ahead, TimeZone.UTC)), { request: REQUEST });
    assert.deepEqual(told, ['2 heavy steps running, the cap 2: po (heavy: build) since 2030-01-08 09:50 UTC, web (heavy: build) since 2030-01-08 09:55 UTC']);
    const capped = '2 heavy steps running, the cap 2: po (heavy: build) since 2030-01-08 11:50 IST, web (heavy: build) since 2030-01-08 11:55 IST';
    assert.deepEqual(seen, [{ reason: 'heavyCap', text: capped, since: '2030-01-08T10:00:00.000Z' }]);
    assert.deepEqual([clock.sleeps, taking.kind === 'taken' ? taking.sharing : undefined], [[FIRST_IN_LINE_POLL_MS], { others: [WEB_HEAVY], heavy: true }]);
  });

  it('keeps a second heavy step waiting at maxHeavyParallel 1, refusing it when its wait runs out, and writes no share', async () => {
    const running = heavyOf();
    const { files, lock } = world(Object.fromEntries([shareFile(running)]), undefined, undefined, { ...PIPELINE, maxHeavyParallel: 1 });
    const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined, { request: REQUEST });
    assert.deepEqual([taking, await files.list(SHARED)], [{ kind: 'busy', holder: { kind: 'heavyCap', cap: 1, running: [running] } }, ['other.json']]);
    assert.equal(taking.kind === 'busy' ? busyText(taking.holder, TimeZone.UTC) : '', 'heavy cap still reached: 1 heavy step running, the cap 1: po (heavy: build) since 2030-01-08 09:50 UTC');
  });

  it('lets a small step share the host beside the heavy steps running at their cap', async () => {
    const running = [heavyOf({ id: 'h1' }), WEB_HEAVY];
    const { lock } = world(Object.fromEntries(running.map((share) => shareFile(share))), undefined, new FakeHostMemory(16_000), PIPELINE);
    const taking = await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, { need: SMALL, request: REQUEST });
    assert.deepEqual(taking.kind === 'taken' ? taking.sharing : undefined, { freeMb: 16_000, others: running, heavy: false }, 'the floor, 8192 MB held for them and its own 2048 fit');
  });

  it("counts the MB held for a heavy step's share at the memory gate", async () => {
    const running = heavyOf();
    const results: unknown[] = [];
    const told: string[] = [];
    for (const freeMb of [12_287, 12_288]) {
      const { lock } = world(Object.fromEntries([shareFile(running)]), undefined, new FakeHostMemory(freeMb), PIPELINE);
      const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, (holder) => told.push(holderText(holder, TimeZone.UTC)), { request: REQUEST });
      results.push(taking.kind === 'busy' ? taking.holder : taking.kind);
    }
    assert.deepEqual(results, [{ kind: 'memory', freeMb: 12_287, heldMb: 4096, needMb: 8192, floorMb: 4096, reserveMb: 4096, shares: [running] }, 'taken']);
    assert.deepEqual(told, ['1 heavy step: po (heavy: build) since 2030-01-08 09:50 UTC; host memory: 12287 MB free, 4096 MB held for it, 8192 MB needed (4096 floor + 4096 for this step)']);
  });

  it('takes the lock file for an exclusive step and with serial rules, sharing nothing, and says on its ticket that it takes the whole host', async () => {
    const results: unknown[] = [];
    const seen: (TicketRequest | undefined)[] = [];
    for (const [admission, exclusive] of [
      [PIPELINE, true],
      [{ ...PIPELINE, mode: 'serial' }, undefined],
      [PIPELINE, undefined],
    ] as const) {
      const ask = { ...(exclusive === undefined ? {} : { exclusive }), request: REQUEST };
      const free = world({}, undefined, undefined, admission);
      const taking = await free.lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined, ask);
      results.push([taking.kind === 'taken' ? taking.sharing?.heavy : taking.kind, free.files.get(PATH) !== undefined, (await free.files.list(SHARED)).length]);
      const held = world({ [PATH]: heldBy() }, (time, store) => async (ms) => {
        seen.push(await requestOf(store, time));
        await time.sleep(ms);
      }, undefined, admission);
      await held.lock.acquire('alpha', 'heavy: build', 2_000, 30_000, () => undefined, ask);
    }
    assert.deepEqual(results, [
      [undefined, true, 0],
      [undefined, true, 0],
      [true, false, 1],
    ]);
    const heavy = { ...REQUEST, needMb: 0, heavy: true };
    assert.deepEqual(seen, [{ ...heavy, exclusive: true }, { ...heavy, exclusive: true }, { ...heavy, exclusive: false }]);
  });

  it('makes an exclusive step that took the lock file wait, holding it, for the heavy steps sharing the host to end', async () => {
    const [path, text] = shareFile(heavyOf());
    const holders: unknown[] = [];
    const { files, lock } = world(
      { [path]: text },
      (time, store) => async (ms) => {
        holders.push(JSON.parse(store.get(PATH) ?? '{}').session);
        await time.sleep(ms);
      },
      undefined,
      PIPELINE,
    );
    const told: string[] = [];
    const taking = await lock.acquire('alpha', 'heavy: deploy', 5_000, 30_000, (holder) => told.push(holderText(holder, TimeZone.UTC)), { exclusive: true, request: REQUEST });
    assert.deepEqual([taking, told], [{ kind: 'busy', holder: { kind: 'draining', shares: [heavyOf()] } }, ['1 heavy step: po (heavy: build) since 2030-01-08 09:50 UTC']]);
    assert.deepEqual([holders, files.get(PATH), files.get(path)], [['alpha', 'alpha', 'alpha'], undefined, text], 'it held the lock while it waited, then released it');
  });

  it('keeps a heavy step behind a held lock file, naming its holder and the heavy step that holder waits for', async () => {
    const { files, lock } = world(Object.fromEntries([[PATH, heldBy()], shareFile(WEB_HEAVY)]), undefined, undefined, PIPELINE);
    const told: string[] = [];
    const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, (holder) => told.push(holderText(holder, TimeZone.UTC)), { request: REQUEST });
    assert.deepEqual([taking, (await files.list(SHARED)).length], [{ kind: 'busy', holder: { kind: 'held', info: infoOf(), waitsFor: [WEB_HEAVY] } }, 1]);
    assert.deepEqual(told, ['po (heavy: build) since 2030-01-08 09:50 UTC, waiting for 1 heavy step: web (heavy: build) since 2030-01-08 09:55 UTC']);
  });

  it("names the heavy steps sharing the host before the small ones, counts them by kind, and takes an older kit's share as small", () => {
    const heavy = [heavyOf({ id: 'h1' }), WEB_HEAVY];
    const small = [shareOf({ id: 's1', session: 'alpha' }), shareOf({ id: 's2', session: 'alpha', acquiredAt: '2030-01-08T09:58:00.000Z' })];
    const heavyText = '2 heavy steps: po (heavy: build) since 2030-01-08 09:50 UTC, web (heavy: build) since 2030-01-08 09:55 UTC';
    const smallText = '2 small steps: alpha (heavy: specs) since 2030-01-08 09:50 UTC, alpha (heavy: specs) since 2030-01-08 09:58 UTC';
    assert.deepEqual(
      [sharesText([...small, ...heavy], TimeZone.UTC), sharesText(heavy, TimeZone.UTC), sharesText(small, TimeZone.UTC)],
      [`${heavyText} and ${smallText}`, heavyText, smallText],
    );
    assert.deepEqual([sharesCount([...small, WEB_HEAVY]), sharesCount(heavy), sharesCount(small)], ['1 heavy step and 2 small steps', '2 heavy steps', '2 small steps']);
    assert.deepEqual([isHeavyShare(WEB_HEAVY), isHeavyShare(shareOf({ heavy: false })), isHeavyShare(shareOf())], [true, false, false]);
    const capped: LockWait = { kind: 'heavyCap', cap: 2, running: heavy };
    const cappedText = '2 heavy steps running, the cap 2: po (heavy: build) since 2030-01-08 09:50 UTC, web (heavy: build) since 2030-01-08 09:55 UTC';
    assert.deepEqual(
      [holderText(capped, TimeZone.UTC), busyText(capped, TimeZone.UTC), waitText(capped, 1, TimeZone.UTC)],
      [cappedText, `heavy cap still reached: ${cappedText}`, `${cappedText}; 1 ahead in line`],
    );
  });
});
