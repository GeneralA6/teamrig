import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FREEZES_LOCK_TTL_MS } from '../delivery/freeze-store.ts';
import type { HostLockInfo, Taking } from '../delivery/host-lock.ts';
import { TimeZone } from '../core/zone.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { freezesLockOf, hostLockOf } from './delivery-ports.ts';
import type { CliRuntime } from './runtime.ts';

const PATH = '/kit/host.lock';
const QUEUE = { lockTtlMinutes: 150, memoryFloorMb: 4096, heavyReserveMb: 4096 };
const HEADROOM = { commitMaxPct: 92 };

/** The CLI's ports over files in memory at 10:00, on a host with `memory`. */
function runtimeOf(memory: FakeHostMemory): Pick<CliRuntime, 'files' | 'clock' | 'sleep' | 'pid' | 'sessionProcesses' | 'newId' | 'memory'> {
  const clock = new FakeClock('2030-01-08T10:00:00Z');
  let ids = 0;
  return {
    files: new MemoryFiles({}, clock),
    clock,
    sleep: clock.sleep,
    pid: 4242,
    sessionProcesses: new FakeSessionProcesses(),
    newId: () => {
      ids += 1;
      return `t${ids}`;
    },
    memory,
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

describe('hostLockOf (T2192)', () => {
  it('gates a step on free memory over delivery.queue.memoryFloorMb plus heavyReserveMb', async () => {
    const lock = hostLockOf(runtimeOf(new FakeHostMemory(100)), PATH, QUEUE, HEADROOM, TimeZone.UTC);

    const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined);

    assert.deepEqual(taking, { kind: 'busy', holder: { kind: 'memory', freeMb: 100, heldMb: 0, needMb: 8192, floorMb: 4096, reserveMb: 4096, shares: [] } });
  });

  it('gates a step on the commit charge under open.headroom.commitMaxPct, the reserve counted', async () => {
    const memory = new FakeHostMemory(16_000).lists([], { usedMb: 28_000, limitMb: 32_000 });
    const lock = hostLockOf(runtimeOf(memory), PATH, QUEUE, HEADROOM, TimeZone.UTC);

    const taking = await lock.acquire('alpha', 'heavy: build', 0, 30_000, () => undefined);

    assert.deepEqual(taking, { kind: 'busy', holder: { kind: 'commit', usedMb: 28_000, limitMb: 32_000, maxPct: 92, reserveMb: 4096, shares: [] } });
  });

  it('holds a lock taken on a roomy host for delivery.queue.lockTtlMinutes', async () => {
    const lock = hostLockOf(runtimeOf(new FakeHostMemory(16_000)), PATH, QUEUE, HEADROOM, TimeZone.UTC);

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
