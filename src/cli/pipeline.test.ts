import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { KIT_VERSION } from '../core/version.ts';
import type { HostShare, LockWaiter } from '../delivery/host-lock.ts';
import type { LedgerRecord } from '../delivery/ledger.ts';
import type { ProcessRow } from '../delivery/memory.ts';
import { CliHarness, KIT, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { BUSY_HOLDERS, BUSY_HOLDERS_TEXT, FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';

const LOCK = join(KIT, 'host.lock');
const LEDGER = join(TEAM_HOME, 'state', 'deploys', 'ledger.jsonl');
const MB = 2 ** 20;
/** A team that lets its line in by `delivery.queue.admission` pipeline, not the default serial arrival order. */
const PIPELINE = { ...TEAM, delivery: { queue: { admission: 'pipeline' } } };
const HOLDER = 9001;
const SHARER = 9002;
const WAITER = 9003;
const OLDER_WAITER = 9004;

/** Each of `pids` runs, so a lock, share or ticket naming it is live. */
function running(...pids: readonly number[]): FakeSessionProcesses {
  return pids.reduce((processes, pid) => processes.add({ pid, parentPid: 1, name: 'node', commandLine: 'node cli.ts queue' }), new FakeSessionProcesses());
}

/** A process of `mb` MB under `parent`. */
function row(pid: number, parent: number, mb: number): ProcessRow {
  return { pid, parent, bytes: mb * MB };
}

/** lead's heavy build, holding the lock since 09:48 UTC. */
const HELD = { token: 'held', pid: HOLDER, session: 'lead', purpose: 'heavy: build', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:48:00.000Z', expiresAt: '2030-01-08T12:18:00.000Z' };

/** alpha's small lint step, sharing the host since 09:57 UTC with 2048 MB held for it. */
const SHARE: HostShare = { id: 'share1', pid: SHARER, session: 'alpha', purpose: 'heavy: lint', kit: KIT_VERSION, acquiredAt: '2030-01-08T09:57:00.000Z', expiresAt: '2030-01-08T10:07:00.000Z', reserveMb: 2048 };

/** bravo's test, in line since 09:55 UTC and waiting on lead's build since then. */
const TESTS: LockWaiter = {
  id: 'w1',
  pid: WAITER,
  session: 'bravo',
  purpose: 'heavy: test',
  kit: KIT_VERSION,
  arrivedAt: '2030-01-08T09:55:00.000Z',
  expiresAt: '2030-01-08T10:55:10.000Z',
  stopsOnWithdraw: true,
  waitingOn: { reason: 'lock', text: 'lead (heavy: build) since 2030-01-08 11:48 IST', since: '2030-01-08T09:55:00.000Z' },
};

/** alpha's specs, in line since 09:59 UTC as an older teamrig queued them: its ticket names no cause. */
const OLDER: LockWaiter = { id: 'w2', pid: OLDER_WAITER, session: 'alpha', purpose: 'heavy: specs', arrivedAt: '2030-01-08T09:59:00.000Z', expiresAt: '2030-01-08T10:59:10.000Z' };

/** Writes each waiter's ticket as teamrig stores it: the id under `token`, the arrival leading its name. */
async function queued(kit: CliHarness, ...waiters: readonly LockWaiter[]): Promise<void> {
  for (const { id, ...rest } of waiters) {
    await kit.files.write(join(`${LOCK}.queue`, `${String(Date.parse(rest.arrivedAt)).padStart(15, '0')}-${id}.json`), JSON.stringify({ token: id, ...rest }));
  }
}

async function shared(kit: CliHarness, share: HostShare): Promise<void> {
  const { id, ...rest } = share;
  await kit.files.write(join(`${LOCK}.shared`, `${id}.json`), JSON.stringify({ token: id, ...rest }));
}

/** bravo's api tests, refused at 09:30 UTC after a 30-minute wait. */
const REFUSED_TODAY: LedgerRecord = {
  type: 'refusal',
  id: 'r1',
  session: 'bravo',
  what: 'test api',
  queuedAt: '2030-01-08T09:00:00.000Z',
  endedAt: '2030-01-08T09:30:00.000Z',
  outcome: 'timedOut',
  reason: 'host lock still held by lead (heavy: build) since 2030-01-08 10:48 IST',
  lastWait: { cause: 'lock', text: 'lead (heavy: build) since 2030-01-08 10:48 IST' },
};

const NO_STEPS = ['RUNNING none', 'WAITING none', 'REFUSED in the last 24h: none'];

describe('teamrig pipeline', () => {
  it("says on a quiet host its free memory, RAM and floor, and that nothing runs, waits or was refused, listing no processes", async () => {
    const kit = new CliHarness(TEAM);
    const memory = new FakeHostMemory(16000).lists(undefined);
    const result = await kit.run(['pipeline'], { memory });
    assert.deepEqual(result, { code: 0, stdout: ['HOST 16000 MB free of 32768 MB, 4096 MB kept free (delivery.queue.memoryFloorMb)', ...NO_STEPS], stderr: [] });
  });

  it("shows the host, the lock's holder and the small steps with their trees, the line with what each waits on, and the last day's refusals on the team's clock", async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(LOCK, JSON.stringify(HELD));
    await shared(kit, SHARE);
    await queued(kit, TESTS, OLDER);
    const refusedBefore: LedgerRecord = { ...REFUSED_TODAY, id: 'r0', endedAt: '2030-01-07T09:59:00.000Z', queuedAt: '2030-01-07T09:00:00.000Z' };
    const ran: LedgerRecord = { type: 'heavy', id: 's1', session: 'alpha', what: 'build', startedAt: '2030-01-08T09:00:00.000Z', endedAt: null, exitCode: null };
    await kit.files.write(LEDGER, [refusedBefore, ran, REFUSED_TODAY].map((record) => JSON.stringify(record)).join('\n') + '\n');
    const rows = [row(HOLDER, 1, 100), row(9101, HOLDER, 2900), row(SHARER, 1, 50), row(9102, SHARER, 450), row(7, 1, 9000)];
    const memory = new FakeHostMemory(7000).lists(rows, { usedMb: 30000, limitMb: 48000 }).holds(BUSY_HOLDERS);
    const result = await kit.run(['pipeline'], { memory, sessionProcesses: running(HOLDER, SHARER, WAITER, OLDER_WAITER), timeZone: 'Asia/Jerusalem' });
    assert.deepEqual(result, {
      code: 0,
      stdout: [
        "HOST 7000 MB free of 32768 MB, 4096 MB kept free (delivery.queue.memoryFloorMb); commit charge 30000 of 48000 MB; 2048 MB held for 1 small step; the running steps' trees use 3500 MB",
        `  ${BUSY_HOLDERS_TEXT}`,
        'RUNNING 2',
        '  lead (heavy: build) holds the lock, for 12m, its tree uses 3000 MB',
        '  alpha (heavy: lint) shares the host, 2048 MB held for it, for 3m, its tree uses 500 MB',
        'WAITING 2',
        '  1. bravo (heavy: test) for 5m, on lock since 2030-01-08 11:55 IST: lead (heavy: build) since 2030-01-08 11:48 IST',
        '  2. alpha (heavy: specs) for 1m: its ticket names no cause (before its first look, or an older teamrig)',
        'REFUSED in the last 24h: 1',
        '  2030-01-08 11:30 IST bravo (test api) timedOut after 30m: host lock still held by lead (heavy: build) since 2030-01-08 10:48 IST',
      ],
      stderr: [],
    });
  });

  it('calls a lock whose process ended free, leaving it in place, and leaves out tree use where the host lists no processes', async () => {
    const kit = new CliHarness(TEAM);
    const stale = JSON.stringify(HELD);
    await kit.files.write(LOCK, stale);
    await shared(kit, SHARE);
    const memory = new FakeHostMemory(16000).lists(undefined);
    const result = await kit.run(['pipeline'], { memory, sessionProcesses: running(SHARER) });
    assert.deepEqual(result.stdout, [
      "HOST 16000 MB free of 32768 MB, 4096 MB kept free (delivery.queue.memoryFloorMb); 2048 MB held for 1 small step; the running steps' trees unknown (the host lists no processes)",
      'RUNNING 1',
      '  the host lock is free: the lock of lead (heavy: build) since 2030-01-08 09:48 UTC is stale, and the next step removes it',
      '  alpha (heavy: lint) shares the host, 2048 MB held for it, for 3m',
      ...NO_STEPS.slice(1),
    ]);
    assert.equal(kit.files.get(LOCK), stale);
  });

  it('counts the heavy steps sharing the host apart from the small ones (T2210)', async () => {
    const kit = new CliHarness(TEAM);
    await shared(kit, SHARE);
    await shared(kit, { ...SHARE, id: 'share2', session: 'bravo', purpose: 'heavy: build', reserveMb: 4096, heavy: true });
    const memory = new FakeHostMemory(16000).lists(undefined);
    const result = await kit.run(['pipeline'], { memory, sessionProcesses: running(SHARER) });
    assert.equal(
      result.stdout[0],
      "HOST 16000 MB free of 32768 MB, 4096 MB kept free (delivery.queue.memoryFloorMb); 6144 MB held for 1 heavy step and 1 small step; the running steps' trees unknown (the host lists no processes)",
    );
  });

  it('names the tabs still loading with the MB held for them, leaving a hold that ran out in place (T2199)', async () => {
    const kit = new CliHarness(TEAM);
    await shared(kit, SHARE);
    const tab = { team: 'alpha', needCommittedMb: 3000, openedAt: '2030-01-08T09:58:00.000Z', expiresAt: '2030-01-08T10:03:00.000Z' };
    const loaded = JSON.stringify({ ...tab, id: 't0', session: 'docs', needMb: 900, expiresAt: '2030-01-08T09:59:00.000Z' });
    await kit.files.write(join(`${LOCK}.tabs`, 't0.json'), loaded);
    await kit.files.write(join(`${LOCK}.tabs`, 't1.json'), JSON.stringify({ ...tab, id: 't1', session: 'web', needMb: 1500 }));
    await kit.files.write(join(`${LOCK}.tabs`, 't2.json'), JSON.stringify({ ...tab, id: 't2', team: 'bravo', session: 'api', needMb: 1000, openedAt: '2030-01-08T09:59:00.000Z' }));
    const memory = new FakeHostMemory(16000).lists(undefined);
    const result = await kit.run(['pipeline'], { memory, sessionProcesses: running(SHARER) });
    assert.equal(
      result.stdout[0],
      "HOST 16000 MB free of 32768 MB, 4096 MB kept free (delivery.queue.memoryFloorMb); 2048 MB held for 1 small step; 2500 MB held for 2 tabs still loading (alpha/web, bravo/api); the running steps' trees unknown (the host lists no processes)",
    );
    assert.equal(kit.files.get(join(`${LOCK}.tabs`, 't0.json')), loaded);
  });

  it('names a heavy step sharing the host as one, and shows the line in the order steps are let in, not arrival (T2210)', async () => {
    const kit = new CliHarness(PIPELINE);
    await shared(kit, { ...SHARE, purpose: 'heavy: build', reserveMb: 4096, heavy: true });
    const urgent: LockWaiter = { ...OLDER, request: { kind: 'test', task: 'T7', priority: 1, class: 'Maintenance', classPct: 25, needMb: 0, heavy: true, exclusive: false } };
    await queued(kit, TESTS, urgent);
    const memory = new FakeHostMemory(16000).lists(undefined);
    const result = await kit.run(['pipeline'], { memory, sessionProcesses: running(SHARER, WAITER, OLDER_WAITER), timeZone: 'Asia/Jerusalem' });
    assert.deepEqual(result.stdout.slice(1, 6), [
      'RUNNING 1',
      '  alpha (heavy: build) shares the host as a heavy step, 4096 MB held for it, for 3m',
      'WAITING 2',
      '  1. alpha (heavy: specs) for 1m: its ticket names no cause (before its first look, or an older teamrig)',
      '  2. bravo (heavy: test) for 5m, on lock since 2030-01-08 11:55 IST: lead (heavy: build) since 2030-01-08 11:48 IST',
    ], "alpha's p1 step goes before bravo's, which names no request and so counts at p2");
  });
});
