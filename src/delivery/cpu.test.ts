import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHostCpu } from '../testing/fake-host-cpu.ts';
import { CPU_READ_GAP_MS, CpuGate, nodeHostCpu, type CpuTimes, type HostCpu } from './cpu.ts';

describe('CpuGate', () => {
  it('finds room when the idle share between two reads reaches the need', async () => {
    const clock = new FakeClock();
    const cpu = new FakeHostCpu(25);

    const look = await new CpuGate(cpu, clock.sleep, 25).look();

    assert.deepEqual(look, { kind: 'room', idlePct: 25 });
    assert.deepEqual(clock.sleeps, [CPU_READ_GAP_MS]);
    assert.equal(cpu.reads, 2);
  });

  it('holds a step back on a host busier than the need, naming the idle share and the need', async () => {
    const look = await new CpuGate(new FakeHostCpu(24), new FakeClock().sleep, 25).look();

    assert.deepEqual(look, { kind: 'cpu', idlePct: 24, needPct: 25 });
  });

  it('reads each look afresh, so a host that calms down lets the step in', async () => {
    const gate = new CpuGate(new FakeHostCpu(80).idles(5, 10), new FakeClock().sleep, 25);

    assert.equal((await gate.look()).kind, 'cpu');
    assert.equal((await gate.look()).kind, 'cpu');
    assert.deepEqual(await gate.look(), { kind: 'room', idlePct: 80 });
  });

  it('lets every step in unread when the need is 0 (the gate off)', async () => {
    const clock = new FakeClock();
    const cpu = new FakeHostCpu(0);

    assert.deepEqual(await new CpuGate(cpu, clock.sleep, 0).look(), { kind: 'room', idlePct: 100 });
    assert.equal(cpu.reads, 0);
    assert.deepEqual(clock.sleeps, []);
  });

  it('finds room when the CPU time did not move between the reads, as nothing shows the host busy', async () => {
    const still: HostCpu = { times: (): CpuTimes => ({ idleMs: 500, totalMs: 1000 }) };

    assert.deepEqual(await new CpuGate(still, new FakeClock().sleep, 25).look(), { kind: 'room', idlePct: 100 });
  });
});

describe('nodeHostCpu', () => {
  it('reads idle time no more than total time, both growing', () => {
    const cpu = nodeHostCpu();
    const first = cpu.times();
    const second = cpu.times();

    assert.ok(first.idleMs <= first.totalMs);
    assert.ok(second.totalMs >= first.totalMs);
    assert.ok(second.idleMs >= first.idleMs);
  });
});
