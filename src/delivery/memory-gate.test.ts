import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import type { CommitCharge } from './memory.ts';
import { FREE_READS, MemoryGate, READ_GAP_MS, shortText, tabsText, type LoadingTab, type MemoryGateConfig } from './memory-gate.ts';

const CONFIG: MemoryGateConfig = { floorMb: 4096, heavyReserveMb: 4096, commitMaxPct: 92 };

/** Host memory that counts its commit-charge reads. */
class CountingMemory extends FakeHostMemory {
  commitReads = 0;

  override async commit(): Promise<CommitCharge | undefined> {
    this.commitReads += 1;
    return super.commit();
  }
}

/** A gate over `memory`, its reads spaced by a fake clock's sleeps, with `loading` the tabs still loading (none by default). */
function gateOf(memory: CountingMemory, config: MemoryGateConfig = CONFIG, loading: readonly LoadingTab[] = []): { gate: MemoryGate; clock: FakeClock } {
  const clock = new FakeClock();
  return { gate: new MemoryGate(memory, clock.sleep, config, async () => loading), clock };
}

/** Two tabs still loading: 1500 + 1000 MB of free memory, 3000 + 2000 MB of the commit charge. */
const TWO_TABS: readonly LoadingTab[] = [
  { needMb: 1500, needCommittedMb: 3000 },
  { needMb: 1000, needCommittedMb: 2000 },
];

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

  it('counts the free memory the tabs still loading will take as held, beside the small steps (T2199)', async () => {
    const memory = new CountingMemory();
    memory.free = 10_000;
    assert.equal((await gateOf(memory).gate.look(2048, 2000)).kind, 'room', 'with no tab loading 10000 - 2000 held leaves 8000 of the 6144 needed');
    const { gate } = gateOf(memory, CONFIG, TWO_TABS);
    assert.equal((await gate.look(2048, 0)).kind, 'room', '10000 - 2500 for the tabs leaves 7500 of the 6144 needed');
    assert.deepEqual(await gate.look(2048, 2000), {
      kind: 'memory',
      freeMb: 10_000,
      heldMb: 2000,
      needMb: 6144,
      floorMb: 4096,
      reserveMb: 2048,
      loading: { tabs: 2, mb: 2500 },
    });
  });

  it('counts the commit charge the tabs still loading will add, the step\'s reserve on top (T2199)', async () => {
    const memory = new CountingMemory().lists([], { usedMb: 22_000, limitMb: 32_000 });
    memory.free = 16_000;
    assert.equal((await gateOf(memory).gate.look(4096, 0)).kind, 'room', 'with no tab loading 22000 + 4096 MB is under 92% of 32000 MB (29440)');
    const { gate } = gateOf(memory, CONFIG, TWO_TABS);
    assert.deepEqual(await gate.look(4096, 0), { kind: 'commit', usedMb: 22_000, limitMb: 32_000, maxPct: 92, reserveMb: 4096, loading: { tabs: 2, mb: 5000 } });
    assert.equal((await gate.look(2440, 0)).kind, 'room', '22000 + 5000 for the tabs + 2440 = 29440 MB is 92% exactly');
    assert.equal((await gate.look(2441, 0)).kind, 'commit');
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

  it('names the MB held for the tabs still loading after the small steps\' (T2199)', () => {
    const loading = { tabs: 2, mb: 2500 };
    assert.equal(
      shortText({ kind: 'memory', freeMb: 7000, heldMb: 0, needMb: 6144, floorMb: 4096, reserveMb: 2048, loading }, 0),
      'host memory: 7000 MB free, 2500 MB held for 2 tabs still loading, 6144 MB needed (4096 floor + 2048 for this step)',
    );
    assert.equal(
      shortText({ kind: 'memory', freeMb: 9000, heldMb: 2048, needMb: 6144, floorMb: 4096, reserveMb: 2048, loading }, 1),
      'host memory: 9000 MB free, 2048 MB held for it, 2500 MB held for 2 tabs still loading, 6144 MB needed (4096 floor + 2048 for this step)',
    );
    assert.equal(
      shortText({ kind: 'commit', usedMb: 22_000, limitMb: 32_000, maxPct: 92, reserveMb: 4096, loading: { tabs: 1, mb: 3000 } }, 0),
      'host commit charge: 22000 of 32000 MB, 3000 MB held for 1 tab still loading and 4096 MB more for this step would pass 92% (open.headroom.commitMaxPct)',
    );
  });

  it('counts tabs in words', () => {
    assert.equal(tabsText(1), '1 tab');
    assert.equal(tabsText(3), '3 tabs');
  });

  it('names where the step\'s MB came from when its need says, except for a need capped at half the host (T2209)', () => {
    const basis = 'learned from 2 runs';
    assert.equal(
      shortText({ kind: 'memory', freeMb: 10_000, heldMb: 0, needMb: 11_596, floorMb: 4096, reserveMb: 7500, basis }, 0),
      'host memory: 10000 MB free, 11596 MB needed (4096 floor + 7500 for this step, learned from 2 runs)',
    );
    assert.equal(
      shortText({ kind: 'commit', usedMb: 30000, limitMb: 32000, maxPct: 92, reserveMb: 2048, basis }, 0),
      'host commit charge: 30000 of 32000 MB, 2048 MB more for this step (learned from 2 runs) would pass 92% (open.headroom.commitMaxPct)',
    );
    assert.equal(
      shortText({ kind: 'memory', freeMb: 5000, heldMb: 0, needMb: 6000, floorMb: 4096, reserveMb: 7500, hostMb: 12000, basis }, 0),
      "host memory: 5000 MB free, 6000 MB needed (half the host's 12000 MB)",
    );
  });
});
