import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KIT_VERSION } from '../core/version.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { BUSY_HOLDERS, BUSY_HOLDERS_TEXT, FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakeSteps } from '../testing/fake-steps.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { marksOfTaking, NOT_STARTED_EXIT, recordQueuedStep, recordRefusal, runRecorded, type RecordedStep, type StepRecordSetup } from './recorded-step.ts';
import { WaitLog, type WaitCause } from './wait-log.ts';

const LEDGER = '/kit/deploys/ledger.jsonl';
const SAMPLED: StepRecordSetup = { places: { ledger: LEDGER }, delivery: { queue: { memorySampleSeconds: 15 } } };
const UNSAMPLED: StepRecordSetup = { places: { ledger: LEDGER }, delivery: { queue: { memorySampleSeconds: 0 } } };
const STEP: RecordedStep = { session: 'po', kind: 'build', what: 'build', request: { command: 'npm run build', cwd: '/app', env: {}, timeoutMs: 60_000 } };
const START = { type: 'heavy', id: 'step-1', session: 'po', what: 'build', kind: 'build', kit: KIT_VERSION, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };

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
    assert.deepEqual(await recordQueuedStep(ports, SAMPLED, { session: 'po', kind: 'deploy', what: 'deploy app' }, work, () => 4), { failedAt: 'pull' });
    const start = { ...START, what: 'deploy app', kind: 'deploy' };
    assert.deepEqual(records(files), [start, { ...start, endedAt: '2030-01-08T10:00:30.000Z', exitCode: 4 }]);
  });

  it('watches work of any kind, and records the memory at a kill its exit code reports', async () => {
    const { files, memory, ports } = world(new FakeHostMemory(1500).measures({ peakTreeMb: 3100 }));
    await recordQueuedStep(ports, SAMPLED, { session: 'po', kind: 'deploy', what: 'deploy app' }, async () => 'killed', () => 129);
    assert.deepEqual(memory.watches, [{ root: 4242, intervalMs: 15_000, stopped: true }]);
    assert.deepEqual(records(files)[1], { ...START, what: 'deploy app', kind: 'deploy', endedAt: '2030-01-08T10:00:00.000Z', exitCode: 129, peakTreeMb: 3100, endFreeMb: 1500 });
  });

  it("records the kind, the task the step works for and the task's priority on its start and end records (T2209)", async () => {
    const { files, ports } = world();
    await recordQueuedStep(ports, UNSAMPLED, { session: 'po', kind: 'test', task: 'T12', priority: 2, what: 'T12 specs' }, async () => 0, () => 0);
    const start = { ...START, what: 'T12 specs', kind: 'test', task: 'T12', priority: 2 };
    assert.deepEqual(records(files), [start, { ...start, endedAt: '2030-01-08T10:00:00.000Z', exitCode: 0 }]);
  });
});

describe('recordQueuedStep: the wait', () => {
  it('records the ms waited by cause and the free memory at the queueing on the start record, the end record keeping them', async () => {
    const { files, steps, ports } = world();
    steps.ends(0, 60_000);
    const waited = { queuedAt: Date.parse('2030-01-08T09:58:00Z'), waits: { memory: 90_000, lock: 30_000 }, queueFreeMb: 3100 };
    await runRecorded(ports, UNSAMPLED, { ...STEP, ...waited });
    const start = { ...START, queuedAt: '2030-01-08T09:58:00.000Z', waits: { memory: 90_000, lock: 30_000 }, queueFreeMb: 3100 };
    assert.deepEqual(records(files), [start, { ...start, endedAt: '2030-01-08T10:01:00.000Z', exitCode: 0 }]);
  });

  it('leaves out the waits of a step that waited on no cause', async () => {
    const { files, steps, ports } = world();
    steps.ends(0, 1_000);
    await runRecorded(ports, UNSAMPLED, { ...STEP, queuedAt: Date.parse('2030-01-08T10:00:00Z'), waits: {}, queueFreeMb: 9000 });
    assert.deepEqual(records(files)[0], { ...START, queuedAt: '2030-01-08T10:00:00.000Z', queueFreeMb: 9000 });
  });
});

describe('marksOfTaking', () => {
  it('puts the wait on the first step a taking of the lock runs, never on the steps after it', () => {
    const waited = { queuedAt: Date.parse('2030-01-08T09:58:00Z'), waits: { freeze: 60_000, lock: 30_000 }, queueFreeMb: 5200 };
    const owner = { session: 'api', kind: 'merge', task: 'T7' } as const;
    const markOf = marksOfTaking(owner, waited);
    assert.deepEqual([markOf('check'), markOf('push'), markOf('push again')], [
      { ...owner, what: 'check', ...waited },
      { ...owner, what: 'push' },
      { ...owner, what: 'push again' },
    ]);
  });
});

describe('recordRefusal', () => {
  it('records a step that waited and did not run: its wait by cause, the last reason and the free memory at both ends (T2209)', async () => {
    const { files, clock, ports } = world(new FakeHostMemory(2500));
    const waits = new WaitLog(clock, 3100);
    waits.tell({ cause: 'lock', text: 'the host lock: beta' });
    clock.advance(30_000);
    waits.tell({ cause: 'memory', text: 'host memory: 2500 MB free' });
    clock.advance(90_000);
    await recordRefusal(ports, LEDGER, waits, { session: 'po', kind: 'build', task: 'T12', priority: 1, what: 'build', outcome: 'timedOut', reason: 'host memory still short' });
    assert.deepEqual(records(files), [
      {
        type: 'refusal',
        id: 'step-1',
        session: 'po',
        what: 'build',
        kind: 'build',
        task: 'T12',
        priority: 1,
        kit: KIT_VERSION,
        queuedAt: '2030-01-08T10:00:00.000Z',
        endedAt: '2030-01-08T10:02:00.000Z',
        outcome: 'timedOut',
        reason: 'host memory still short',
        waits: { lock: 30_000, memory: 90_000 },
        lastWait: { cause: 'memory', text: 'host memory: 2500 MB free' },
        queueFreeMb: 3100,
        endFreeMb: 2500,
      },
    ]);
  });

  it('records nothing for a step refused before it waited on anything, and keeps its reason (T2209)', async () => {
    const { files, clock, memory, ports } = world(new FakeHostMemory().holds(BUSY_HOLDERS));
    assert.equal(await recordRefusal(ports, LEDGER, new WaitLog(clock, 9000), { session: 'po', kind: 'build', what: 'build', outcome: 'refused', reason: 'queue cutoff' }), 'queue cutoff');
    assert.deepEqual([files.get(LEDGER), memory.holderLooks], [undefined, 0]);
  });
});

describe('recordRefusal: the top memory holders (T2209)', () => {
  /** Refuses po's build after a minute's wait on `cause`, returning the reason it gives and the reason it records. */
  async function refusedAfter(cause: WaitCause, memory: FakeHostMemory): Promise<{ readonly given: string; readonly recorded: unknown }> {
    const { files, clock, ports } = world(memory);
    const waits = new WaitLog(clock, 3100);
    waits.tell({ cause, text: `waiting on ${cause}` });
    clock.advance(60_000);
    const given = await recordRefusal(ports, LEDGER, waits, { session: 'po', kind: 'build', what: 'build', outcome: 'timedOut', reason: 'still short' });
    const [record] = records(files);
    return { given, recorded: typeof record === 'object' && record !== null && 'reason' in record ? record.reason : undefined };
  }

  it('names them after the reason it records and returns, when the last wait was on host memory or its commit charge', async () => {
    for (const cause of ['memory', 'commit'] as const) {
      const memory = new FakeHostMemory().holds(BUSY_HOLDERS);
      const reason = `still short; ${BUSY_HOLDERS_TEXT}`;
      assert.deepEqual([await refusedAfter(cause, memory), memory.holderLooks], [{ given: reason, recorded: reason }, 1], cause);
    }
  });

  it('never looks at them when the last wait was on anything else', async () => {
    const memory = new FakeHostMemory().holds(BUSY_HOLDERS);
    assert.deepEqual([await refusedAfter('lock', memory), memory.holderLooks], [{ given: 'still short', recorded: 'still short' }, 0]);
  });

  it('keeps the reason when the host lists no holder, or cannot list them', async () => {
    for (const holders of [[], undefined]) {
      assert.deepEqual(await refusedAfter('memory', new FakeHostMemory().holds(holders)), { given: 'still short', recorded: 'still short' });
    }
  });
});
