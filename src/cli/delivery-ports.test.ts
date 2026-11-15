import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FREEZES_LOCK_TTL_MS } from '../delivery/freeze-store.ts';
import type { HostLockInfo, Taking } from '../delivery/host-lock.ts';
import { TimeZone } from '../core/zone.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHostCpu } from '../testing/fake-host-cpu.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { TabHolds, tabHoldsDir } from '../sessions/tab-holds.ts';
import { freezesLockOf, hostLockOf } from './delivery-ports.ts';
import type { CliRuntime } from './runtime.ts';

const PATH = '/kit/host.lock';
const QUEUE = { lockTtlMinutes: 150, memoryFloorMb: 4096, heavyReserveMb: 4096, admission: 'pipeline', agingMinutes: 15, memoryPassMinutes: 15, perSessionRunning: 1, maxHeavyParallel: 2, heavyIdleCpuPct: 25 } as const;
const HEADROOM = { commitMaxPct: 92 };
const FOCUS = { defaultClass: 'Improvements' };
const PID = 4242;

/** A small step's ask: to share the host with 100 MB held for it. */
const SMALL = { need: { shares: true, reserveMb: 100 } };

/**
 * The CLI's ports over files in memory at `clock`'s time (10:00 by default), on a host with `memory` and `cpu` (idle by
 * default), where `processes` run (none by default).
 */
function runtimeOf(
  memory: FakeHostMemory,
  processes: FakeSessionProcesses = new FakeSessionProcesses(),
  clock: FakeClock = new FakeClock('2030-01-08T10:00:00Z'),
  cpu: FakeHostCpu = new FakeHostCpu(),
): Pick<CliRuntime, 'files' | 'clock' | 'sleep' | 'pid' | 'sessionProcesses' | 'newId' | 'memory' | 'cpu'> {
  let ids = 0;
  return {
    files: new MemoryFiles({}, clock),
    clock,
    sleep: clock.sleep,
    pid: PID,
    sessionProcesses: processes,
    newId: () => {
      ids += 1;
      return `t${ids}`;
    },
    memory,
    cpu,
  };
}

/** The lock a step took; fails the spec when it was not taken. */
function heldLock(taking: Taking): HostLockInfo {
  assert.equal(taking.kind, 'taken');
  if (taking.kind !== 'taken') {
    throw new Error('the lock was not taken');
  }
  return taking.lock;
}

function heldMinutes(lock: HostLockInfo): number {
  return (Date.parse(lock.expiresAt) - Date.parse(lock.acquiredAt)) / 60_000;
}

describe('hostLockOf (T2210)', () => {
  /** This process, alive, so the share its first small step takes stays live. */
  const running = (): FakeSessionProcesses => new FakeSessionProcesses().add({ pid: PID, parentPid: 1, name: 'node', commandLine: 'node cli.ts queue' });

  it('orders the line by delivery.queue.admission: in pipeline mode a session running perSessionRunning steps waits on its cap', async () => {
    const lock = hostLockOf(runtimeOf(new FakeHostMemory(16_000), running()), PATH, QUEUE, HEADROOM, FOCUS, TimeZone.UTC);
    const first = heldLock(await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, SMALL));

    const second = await lock.acquire('alpha', 'heavy: lint', 0, 30_000, () => undefined, SMALL);

    assert.equal(second.kind, 'busy');
    assert.deepEqual(second.kind === 'busy' ? second.holder : undefined, { kind: 'sessionCap', cap: 1, running: [first] });
  });

  it('caps no session in serial mode, the line in arrival order as before', async () => {
    const lock = hostLockOf(runtimeOf(new FakeHostMemory(16_000), running()), PATH, { ...QUEUE, admission: 'serial' }, HEADROOM, FOCUS, TimeZone.UTC);
    heldLock(await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, SMALL));

    const second = await lock.acquire('alpha', 'heavy: lint', 0, 30_000, () => undefined, SMALL);

    assert.equal(second.kind, 'taken');
  });

  it('caps no session when delivery.queue.perSessionRunning is 0', async () => {
    const lock = hostLockOf(runtimeOf(new FakeHostMemory(16_000), running()), PATH, { ...QUEUE, perSessionRunning: 0 }, HEADROOM, FOCUS, TimeZone.UTC);
    heldLock(await lock.acquire('alpha', 'heavy: specs', 0, 30_000, () => undefined, SMALL));

    const second = await lock.acquire('alpha', 'heavy: lint', 0, 30_000, () => undefined, SMALL);

    assert.equal(second.kind, 'taken');
  });
});

describe('hostLockOf (T2700)', () => {
  const running = (): FakeSessionProcesses => new FakeSessionProcesses().add({ pid: PID, parentPid: 1, name: 'node', commandLine: 'node cli.ts queue' });

  it('keeps a second heavy step off a host whose CPU is less than delivery.queue.heavyIdleCpuPct idle, and lets it in at 0', async () => {
    const results: unknown[] = [];
    for (const heavyIdleCpuPct of [25, 0]) {
      const runtime = runtimeOf(new FakeHostMemory(16_000), running(), new FakeClock('2030-01-08T10:00:00Z'), new FakeHostCpu(10));
      const lock = hostLockOf(runtime, PATH, { ...QUEUE, heavyIdleCpuPct }, HEADROOM, FOCUS, TimeZone.UTC);
      const first = heldLock(await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined));
      const second = await lock.acquire('beta', 'heavy: build', 0, 30_000, () => undefined);
      results.push(second.kind === 'busy' ? second.holder : second.kind, first);
    }
    const [busy, running25, taken] = results;
    assert.deepEqual([busy, taken], [{ kind: 'cpu', idlePct: 10, needPct: 25, running: [running25] }, 'taken']);
  });
});

describe('hostLockOf (T2192)', () => {
  it('gates a step on free memory over delivery.queue.memoryFloorMb plus heavyReserveMb', async () => {
    const lock = hostLockOf(runtimeOf(new FakeHostMemory(100)), PATH, QUEUE, HEADROOM, FOCUS, TimeZone.UTC);

    const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined);

    assert.deepEqual(taking, { kind: 'busy', holder: { kind: 'memory', freeMb: 100, heldMb: 0, needMb: 8192, floorMb: 4096, reserveMb: 4096, shares: [] } });
  });

  it('gates a step on the commit charge under open.headroom.commitMaxPct, the reserve counted', async () => {
    const memory = new FakeHostMemory(16_000).lists([], { usedMb: 28_000, limitMb: 32_000 });
    const lock = hostLockOf(runtimeOf(memory), PATH, QUEUE, HEADROOM, FOCUS, TimeZone.UTC);

    const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined);

    assert.deepEqual(taking, { kind: 'busy', holder: { kind: 'commit', usedMb: 28_000, limitMb: 32_000, maxPct: 92, reserveMb: 4096, shares: [] } });
  });

  it('counts the tabs still loading beside the lock as held, until their holds run out (T2199)', async () => {
    const clock = new FakeClock('2030-01-08T10:00:00Z');
    const runtime = runtimeOf(new FakeHostMemory(10_000), new FakeSessionProcesses(), clock);
    const tabs = new TabHolds(tabHoldsDir(PATH), runtime);
    await tabs.add({ id: 'h1', team: 'alpha', session: 'web', needMb: 2500, needCommittedMb: 5000, openedAt: '2030-01-08T10:00:00.000Z', expiresAt: '2030-01-08T10:05:00.000Z' });
    const lock = hostLockOf(runtime, PATH, QUEUE, HEADROOM, FOCUS, TimeZone.UTC);

    const waiting = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined);
    clock.advance(5 * 60_000);
    const loaded = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined);

    assert.deepEqual(waiting, {
      kind: 'busy',
      holder: { kind: 'memory', freeMb: 10_000, heldMb: 0, needMb: 8192, floorMb: 4096, reserveMb: 4096, loading: { tabs: 1, mb: 2500 }, shares: [] },
    });
    assert.equal(loaded.kind, 'taken', '10000 MB free clears the 8192 needed once the tab has loaded');
  });

  it('holds a lock taken on a roomy host for delivery.queue.lockTtlMinutes', async () => {
    const lock = hostLockOf(runtimeOf(new FakeHostMemory(16_000)), PATH, QUEUE, HEADROOM, FOCUS, TimeZone.UTC);

    const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined);

    assert.equal(heldMinutes(heldLock(taking)), 150);
  });
});

describe('freezesLockOf (T2192)', () => {
  it('takes its lock for a minute however short host memory is, as it guards no step', async () => {
    const lock = freezesLockOf(runtimeOf(new FakeHostMemory(100)), PATH, TimeZone.UTC);

    const taking = await lock.acquire('alpha', 'freeze: write', 0, 30_000, () => undefined);

    assert.equal(heldMinutes(heldLock(taking)), FREEZES_LOCK_TTL_MS / 60_000);
  });
});
