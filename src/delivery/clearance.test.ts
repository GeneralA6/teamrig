import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KIT_VERSION } from '../core/version.ts';
import { TimeZone } from '../core/zone.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { takeWhenClear, type ClearancePhase, type ClearanceRequest, type Readiness } from './clearance.ts';
import { withdrawnLock } from '../testing/withdrawn-lock.ts';
import { HostLock, type HostLockInfo } from './host-lock.ts';
import { MemoryGate } from './memory-gate.ts';

const LOCK_PATH = '/kit/host.lock';
const ME = 4242;
const OTHER = 9001;
const POLL_MS = 30_000;

/** Another step's lock, held until 12:20 by a process that runs. */
const OTHERS_LOCK = JSON.stringify({
  token: 'other',
  pid: OTHER,
  session: 'po',
  purpose: 'heavy: build',
  kit: KIT_VERSION,
  acquiredAt: '2030-01-08T09:50:00.000Z',
  expiresAt: '2030-01-08T12:20:00.000Z',
});

interface World {
  readonly files: MemoryFiles;
  readonly clock: FakeClock;
  readonly lock: HostLock;
  readonly waits: string[];
  readonly request: ClearanceRequest;
}

/**
 * A deploy step's lock over files in memory at 10:00, waiting at most `maxWaitMs`; with `memory`, the step passes a
 * memory gate over that host first (the config defaults; its read gaps take no time).
 */
function world(initial: Readonly<Record<string, string>> = {}, maxWaitMs: number = 60 * 60_000, memory?: FakeHostMemory): World {
  const files = new MemoryFiles(initial);
  const clock = new FakeClock('2030-01-08T10:00:00Z');
  const lock = new HostLock(LOCK_PATH, 150 * 60_000, {
    files,
    clock,
    sleep: clock.sleep,
    pid: ME,
    alive: (pid) => pid === ME || pid === OTHER,
    newId: () => 'mine',
    ...(memory === undefined ? {} : { memory: new MemoryGate(memory, async () => undefined, { floorMb: 4096, heavyReserveMb: 4096, commitMaxPct: 92 }) }),
  });
  const waits: string[] = [];
  return { files, clock, lock, waits, request: { session: 'api', purpose: 'merge api', maxWaitMs, pollMs: POLL_MS, onWait: (reason) => waits.push(reason), zone: TimeZone.UTC } };
}

/** Answers the readiness checks in turn, the last one from then on. */
function answers(...replies: readonly Readiness[]): () => Promise<Readiness> {
  let asked = 0;
  return async () => {
    const reply = replies[Math.min(asked, replies.length - 1)];
    asked += 1;
    assert.ok(reply !== undefined);
    return reply;
  };
}

const GO: Readiness = { kind: 'go' };
const FROZEN: Readiness = { kind: 'wait', reason: 'deploy freeze by po on cloud-api until 2030-01-08 10:02 UTC (p95)' };

describe('takeWhenClear', () => {
  it('takes the lock at once when nothing holds the step', async () => {
    const { files, clock, lock, waits, request } = world();
    const clearance = await takeWhenClear(answers(GO), { lock, clock, sleep: clock.sleep }, request);
    assert.equal(clearance.kind, 'taken');
    assert.match(files.get(LOCK_PATH) ?? '', /"purpose":"merge api"/);
    assert.deepEqual(waits, []);
  });

  it('refuses at once, without the lock, on a cutoff or blackout', async () => {
    const { files, clock, lock, request } = world();
    const clearance = await takeWhenClear(answers({ kind: 'refuse', reason: 'queue cutoff after 22:30 UTC' }), { lock, clock, sleep: clock.sleep }, request);
    assert.deepEqual(clearance, { kind: 'refused', reason: 'queue cutoff after 22:30 UTC' });
    assert.equal(files.get(LOCK_PATH), undefined);
    assert.deepEqual(clock.sleeps, []);
  });

  it('waits out a freeze, logging its reason once, then takes the lock', async () => {
    const { clock, lock, waits, request } = world();
    const clearance = await takeWhenClear(answers(FROZEN, FROZEN, FROZEN, GO), { lock, clock, sleep: clock.sleep }, request);
    assert.equal(clearance.kind, 'taken');
    assert.deepEqual(waits, [FROZEN.reason]);
    assert.deepEqual(clock.sleeps, [POLL_MS, POLL_MS, POLL_MS]);
  });

  it('gives up when a freeze outlasts the wait, sleeping no further than its end', async () => {
    const { files, clock, lock, request } = world({}, 45_000);
    const clearance = await takeWhenClear(answers(FROZEN), { lock, clock, sleep: clock.sleep }, request);
    assert.deepEqual(clearance, { kind: 'gaveUp', reason: FROZEN.reason });
    assert.deepEqual(clock.sleeps, [POLL_MS, 15_000]);
    assert.equal(files.get(LOCK_PATH), undefined);
  });

  it('gives up when another step holds the lock past the wait', async () => {
    const { clock, lock, waits, request } = world({ [LOCK_PATH]: OTHERS_LOCK }, 60_000);
    const clearance = await takeWhenClear(answers(GO), { lock, clock, sleep: clock.sleep }, request);
    assert.equal(clearance.kind, 'gaveUp');
    assert.match(clearance.kind === 'gaveUp' ? clearance.reason : '', /^host lock still held by po/);
    assert.equal(waits.length, 1);
    assert.match(waits[0] ?? '', /^the host lock: po/);
  });

  it('gives up naming the host memory when it stays short past the wait, holding no lock (T2192)', async () => {
    const { files, clock, lock, waits, request } = world({}, 60_000, new FakeHostMemory(5000));
    const clearance = await takeWhenClear(answers(GO), { lock, clock, sleep: clock.sleep }, request);
    const short = 'host memory: 5000 MB free, 8192 MB needed (4096 floor + 4096 for this step)';
    assert.deepEqual([clearance, waits, files.get(LOCK_PATH)], [{ kind: 'gaveUp', reason: `host memory still short: ${short}` }, [`the host lock: ${short}`], undefined]);
  });

  it("refuses, holding no lock, when its place in the host lock's line was withdrawn", async () => {
    const { clock, request } = world();
    const released: HostLockInfo[] = [];
    const clearance = await takeWhenClear(answers(GO), { lock: withdrawnLock(released), clock, sleep: clock.sleep }, request);
    assert.deepEqual([clearance, released], [{ kind: 'refused', reason: "withdrawn from the host lock's line (teamrig withdraw)" }, []]);
  });

  it('names the phase of each ask: before the lock, then under it', async () => {
    const { clock, lock, request } = world();
    const asked: ClearancePhase[] = [];
    const reply = answers(GO, FROZEN, GO, GO);
    const clearance = await takeWhenClear(
      async (phase) => {
        asked.push(phase);
        return reply();
      },
      { lock, clock, sleep: clock.sleep },
      request,
    );
    assert.equal(clearance.kind, 'taken');
    assert.deepEqual(asked, ['before', 'locked', 'before', 'locked']);
  });

  it('releases the lock and waits again when a freeze started while it waited for the lock', async () => {
    const { files, clock, lock, waits, request } = world();
    const clearance = await takeWhenClear(answers(GO, FROZEN, FROZEN, GO, GO), { lock, clock, sleep: clock.sleep }, request);
    assert.equal(clearance.kind, 'taken');
    assert.deepEqual(waits, [FROZEN.reason]);
    assert.deepEqual(clock.sleeps, [POLL_MS, POLL_MS]);
    assert.match(files.get(LOCK_PATH) ?? '', /"session":"api"/);
  });

  it('releases the lock and refuses when the cutoff passed while it waited for the lock', async () => {
    const { files, clock, lock, request } = world();
    const clearance = await takeWhenClear(answers(GO, { kind: 'refuse', reason: 'cutoff' }), { lock, clock, sleep: clock.sleep }, request);
    assert.deepEqual(clearance, { kind: 'refused', reason: 'cutoff' });
    assert.equal(files.get(LOCK_PATH), undefined);
  });

  it('releases the lock and gives up when a freeze found under the lock outlasts the wait', async () => {
    const { files, clock, lock, request } = world({}, 0);
    const clearance = await takeWhenClear(answers(GO, FROZEN), { lock, clock, sleep: clock.sleep }, request);
    assert.deepEqual(clearance, { kind: 'gaveUp', reason: FROZEN.reason });
    assert.equal(files.get(LOCK_PATH), undefined);
  });
});
