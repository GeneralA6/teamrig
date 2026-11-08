import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import type { CommitCharge } from './memory.ts';
import { FREE_READS, MemoryGate, READ_GAP_MS, shortText, type MemoryGateConfig } from './memory-gate.ts';

const CONFIG: MemoryGateConfig = { floorMb: 4096, heavyReserveMb: 4096, commitMaxPct: 92 };

/** Host memory that counts its commit-charge reads. */
class CountingMemory extends FakeHostMemory {
  commitReads = 0;

  override async commit(): Promise<CommitCharge | undefined> {
    this.commitReads += 1;
    return super.commit();
  }
}

/** A gate over `memory`, its reads spaced by a fake clock's sleeps. */
function gateOf(memory: CountingMemory, config: MemoryGateConfig = CONFIG): { gate: MemoryGate; clock: FakeClock } {
  const clock = new FakeClock();
  return { gate: new MemoryGate(memory, clock.sleep, config), clock };
}

describe('MemoryGate.look', () => {
  it('finds room once three reads a second apart clear the floor and the reserve, then reads the commit charge once', async () => {
    const memory = new CountingMemory().readsFree(9000, 8500, 8800);
    const { gate, clock } = gateOf(memory);
    assert.deepEqual(await gate.look(4096, 0), { kind: 'room', freeMb: 8500 });
    assert.equal(FREE_READS, 3);
    assert.deepEqual(clock.sleeps, [READ_GAP_MS, READ_GAP_MS]);
    assert.equal(memory.commitReads, 1);
  });

  it('is short at once on a first read under the need, with no wait and no commit read', async () => {
    const memory = new CountingMemory().readsFree(6000);
    const { gate, clock } = gateOf(memory);
    assert.deepEqual(await gate.look(2048, 0), { kind: 'memory', freeMb: 6000, heldMb: 0, needMb: 6144, floorMb: 4096, reserveMb: 2048 });
    assert.deepEqual(clock.sleeps, []);
    assert.equal(memory.commitReads, 0);
  });

  it('counts the least of its reads: a later read under the need makes it short', async () => {
    const memory = new CountingMemory().readsFree(9000, 7000, 9000);
    const { gate, clock } = gateOf(memory);
    assert.deepEqual(await gate.look(4096, 0), { kind: 'memory', freeMb: 7000, heldMb: 0, needMb: 8192, floorMb: 4096, reserveMb: 4096 });
    assert.deepEqual(clock.sleeps, [READ_GAP_MS]);
    assert.equal(memory.commitReads, 0);
  });

  it('counts the MB held for the small steps sharing the host as taken', async () => {
    const memory = new CountingMemory();
    memory.free = 9000;
    const { gate } = gateOf(memory);
    assert.equal((await gate.look(2048, 2048)).kind, 'room', '9000 - 2048 held leaves 6952 of the 6144 needed');
    assert.deepEqual(await gate.look(2048, 3000), { kind: 'memory', freeMb: 9000, heldMb: 3000, needMb: 6144, floorMb: 4096, reserveMb: 2048 });
  });

  it('needs at most half the host RAM, so a small host still runs a step', async () => {
    const memory = new CountingMemory();
    memory.total = 12000;
    memory.free = 6500;
    const { gate } = gateOf(memory);
    assert.equal((await gate.look(4096, 0)).kind, 'room', 'the floor and the reserve (8192 MB) pass half of 12000 MB, so 6000 MB is needed');
    memory.free = 5000;
    assert.deepEqual(await gate.look(4096, 0), { kind: 'memory', freeMb: 5000, heldMb: 0, needMb: 6000, floorMb: 4096, reserveMb: 4096, hostMb: 12000 });
  });

  it('is short on a commit charge the reserve would push past its percent of the limit, and passes one at it exactly', async () => {
    const memory = new CountingMemory().lists([], { usedMb: 27392, limitMb: 32000 });
    memory.free = 16000;
    const { gate } = gateOf(memory);
    assert.deepEqual(await gate.look(2049, 0), { kind: 'commit', usedMb: 27392, limitMb: 32000, maxPct: 92, reserveMb: 2049 });
    assert.equal((await gate.look(2048, 0)).kind, 'room', '27392 + 2048 = 29440 MB is 92% of 32000 MB exactly');
  });

  it('checks free memory only on a host that gives no commit charge', async () => {
    const memory = new CountingMemory();
    memory.free = 16000;
    const { gate } = gateOf(memory);
    assert.deepEqual(await gate.look(4096, 0), { kind: 'room', freeMb: 16000 });
    assert.equal(memory.commitReads, 1);
  });
});

describe('shortText', () => {
  it('names the free memory, the need and how it is counted', () => {
    assert.equal(
      shortText({ kind: 'memory', freeMb: 6000, heldMb: 0, needMb: 8192, floorMb: 4096, reserveMb: 4096 }, 0),
      'host memory: 6000 MB free, 8192 MB needed (4096 floor + 4096 for this step)',
    );
  });

  it('names the MB held for the small steps sharing the host', () => {
    const short = { kind: 'memory', freeMb: 7000, heldMb: 2048, needMb: 6144, floorMb: 4096, reserveMb: 2048 } as const;
    assert.equal(shortText(short, 1), 'host memory: 7000 MB free, 2048 MB held for it, 6144 MB needed (4096 floor + 2048 for this step)');
    assert.equal(shortText(short, 2), 'host memory: 7000 MB free, 2048 MB held for them, 6144 MB needed (4096 floor + 2048 for this step)');
  });

  it('names a need capped at half the host', () => {
    assert.equal(
      shortText({ kind: 'memory', freeMb: 5000, heldMb: 0, needMb: 6000, floorMb: 4096, reserveMb: 4096, hostMb: 12000 }, 0),
      "host memory: 5000 MB free, 6000 MB needed (half the host's 12000 MB)",
    );
  });

  it('names the commit charge, the reserve and the key that sets its percent', () => {
    assert.equal(
      shortText({ kind: 'commit', usedMb: 30000, limitMb: 32000, maxPct: 92, reserveMb: 2048 }, 0),
      'host commit charge: 30000 of 32000 MB, 2048 MB more for this step would pass 92% (open.headroom.commitMaxPct)',
    );
  });
});
