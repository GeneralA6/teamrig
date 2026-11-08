import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KIT_VERSION } from '../core/version.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakeSteps } from '../testing/fake-steps.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { marksOfTaking, NOT_STARTED_EXIT, recordQueuedStep, runRecorded, type RecordedStep, type StepRecordSetup } from './recorded-step.ts';

const LEDGER = '/kit/deploys/ledger.jsonl';
const SAMPLED: StepRecordSetup = { places: { ledger: LEDGER }, delivery: { queue: { memorySampleSeconds: 15 } } };
const UNSAMPLED: StepRecordSetup = { places: { ledger: LEDGER }, delivery: { queue: { memorySampleSeconds: 0 } } };
const STEP: RecordedStep = { session: 'po', what: 'build', request: { command: 'npm run build', cwd: '/app', env: {}, timeoutMs: 60_000 } };
const START = { type: 'heavy', id: 'step-1', session: 'po', what: 'build', kit: KIT_VERSION, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };

interface World {
  readonly files: MemoryFiles;
  readonly clock: FakeClock;
  readonly steps: FakeSteps;
  readonly memory: FakeHostMemory;
  readonly ports: Parameters<typeof runRecorded>[0];
}

function world(memory: FakeHostMemory = new FakeHostMemory()): World {
  const files = new MemoryFiles();
  const clock = new FakeClock('2030-01-08T10:00:00Z');
  const steps = new FakeSteps(clock);
  return { files, clock, steps, memory, ports: { files, clock, steps, memory, pid: 4242, newId: () => 'step-1' } };
}

function records(files: MemoryFiles): unknown[] {
  return (files.get(LEDGER) ?? '').split('\n').filter((line) => line !== '').map((line): unknown => JSON.parse(line));
}

describe('runRecorded', () => {
  it('records the start, runs the step and records its end with its exit code', async () => {
    const { files, steps, ports } = world();
    steps.ends(3, 90_000);
    assert.deepEqual(await runRecorded(ports, SAMPLED, STEP), { kind: 'exited', code: 3 });
    assert.deepEqual(steps.ran, [STEP.request]);
    assert.deepEqual(records(files), [START, { ...START, endedAt: '2030-01-08T10:01:30.000Z', exitCode: 3 }]);
  });

  it('records a step that could not start as exit 1 and passes its error on', async () => {
    const { files, steps, ports } = world();
    steps.failsWith(new Error('no such folder'));
    await assert.rejects(runRecorded(ports, SAMPLED, STEP), /no such folder/);
    assert.equal(records(files).length, 2);
    assert.deepEqual(records(files)[1], { ...START, endedAt: '2030-01-08T10:00:00.000Z', exitCode: NOT_STARTED_EXIT });
  });

  it('records when the step began to wait, and its memory on the end record, from a watch of its tree', async () => {
    const { files, steps, memory, ports } = world(new FakeHostMemory().measures({ peakTreeMb: 2400, lowFreeMb: 6100, startFreeMb: 7400 }));
    steps.ends(0, 60_000);
    const queued = { ...STEP, queuedAt: Date.parse('2030-01-08T09:58:00Z') };
    await runRecorded(ports, SAMPLED, queued);
    assert.deepEqual(memory.watches, [{ root: 4242, intervalMs: 15_000, stopped: true }]);
    const start = { ...START, queuedAt: '2030-01-08T09:58:00.000Z' };
    assert.deepEqual(records(files), [start, { ...start, endedAt: '2030-01-08T10:01:00.000Z', exitCode: 0, peakTreeMb: 2400, lowFreeMb: 6100, startFreeMb: 7400 }]);
  });

  it('stops the watch of a step that could not start, and records what it measured', async () => {
    const { files, steps, memory, ports } = world(new FakeHostMemory().measures({ lowFreeMb: 7000 }));
    steps.failsWith(new Error('no such folder'));
    await assert.rejects(runRecorded(ports, SAMPLED, STEP), /no such folder/);
    assert.equal(memory.watches[0]?.stopped, true);
    assert.deepEqual(records(files)[1], { ...START, endedAt: '2030-01-08T10:00:00.000Z', exitCode: NOT_STARTED_EXIT, lowFreeMb: 7000 });
  });

  it('records the host free memory and commit charge at the end of a step killed as its shell ended', async () => {
    const { files, steps, ports } = world(new FakeHostMemory(900).lists([], { usedMb: 61_000, limitMb: 64_000 }).measures({ lowFreeMb: 1200 }));
    steps.ends({ kind: 'stopped' }, 30_000);
    await runRecorded(ports, SAMPLED, STEP);
    assert.deepEqual(records(files)[1], { ...START, endedAt: '2030-01-08T10:00:30.000Z', exitCode: 129, lowFreeMb: 1200, endFreeMb: 900, commitMb: 61_000, commitLimitMb: 64_000 });
  });

  it('records the host free memory at the end of a step killed at its time limit, with no commit charge where the host reads none', async () => {
    const { files, steps, ports } = world(new FakeHostMemory(2100));
    steps.ends({ kind: 'timedOut' }, 60_000);
    await runRecorded(ports, SAMPLED, STEP);
    assert.deepEqual(records(files)[1], { ...START, endedAt: '2030-01-08T10:01:00.000Z', exitCode: 124, endFreeMb: 2100 });
  });

  it('records no memory at the end of a step that failed on its own', async () => {
    const { files, steps, ports } = world(new FakeHostMemory(900).lists([], { usedMb: 61_000, limitMb: 64_000 }));
    steps.ends(1, 30_000);
    await runRecorded(ports, SAMPLED, STEP);
    assert.deepEqual(records(files)[1], { ...START, endedAt: '2030-01-08T10:00:30.000Z', exitCode: 1 });
  });

  it('with sampling off, watches nothing and records no memory, even for a killed step', async () => {
    const { files, steps, memory, ports } = world(new FakeHostMemory(900).lists([], { usedMb: 61_000, limitMb: 64_000 }).measures({ lowFreeMb: 1200 }));
    steps.ends({ kind: 'stopped' }, 30_000);
    await runRecorded(ports, UNSAMPLED, STEP);
    assert.deepEqual(memory.watches, []);
    assert.deepEqual(records(files)[1], { ...START, endedAt: '2030-01-08T10:00:30.000Z', exitCode: 129 });
  });
});

describe('recordQueuedStep', () => {
  it('records work of any kind as one step, its exit code read from what it returns', async () => {
    const { files, clock, ports } = world();
    const work = async (): Promise<{ readonly failedAt: string }> => {
      clock.advance(30_000);
      return { failedAt: 'pull' };
    };
    assert.deepEqual(await recordQueuedStep(ports, SAMPLED, { session: 'po', what: 'deploy app' }, work, () => 4), { failedAt: 'pull' });
    const start = { ...START, what: 'deploy app' };
    assert.deepEqual(records(files), [start, { ...start, endedAt: '2030-01-08T10:00:30.000Z', exitCode: 4 }]);
  });

  it('watches work of any kind, and records the memory at a kill its exit code reports', async () => {
    const { files, memory, ports } = world(new FakeHostMemory(1500).measures({ peakTreeMb: 3100 }));
    await recordQueuedStep(ports, SAMPLED, { session: 'po', what: 'deploy app' }, async () => 'killed', () => 129);
    assert.deepEqual(memory.watches, [{ root: 4242, intervalMs: 15_000, stopped: true }]);
    assert.deepEqual(records(files)[1], { ...START, what: 'deploy app', endedAt: '2030-01-08T10:00:00.000Z', exitCode: 129, peakTreeMb: 3100, endFreeMb: 1500 });
  });
});

describe('marksOfTaking', () => {
  it('puts the wait on the first step a taking of the lock runs, never on the steps after it', () => {
    const markOf = marksOfTaking('api', Date.parse('2030-01-08T09:58:00Z'));
    assert.deepEqual([markOf('check'), markOf('push'), markOf('push again')], [
      { session: 'api', what: 'check', queuedAt: Date.parse('2030-01-08T09:58:00Z') },
      { session: 'api', what: 'push' },
      { session: 'api', what: 'push again' },
    ]);
  });
});
