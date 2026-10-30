import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KIT_VERSION } from '../core/version.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakeSteps } from '../testing/fake-steps.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { marksOfTaking, NOT_STARTED_EXIT, recordQueuedStep, runRecorded, type RecordedStep } from './recorded-step.ts';

const LEDGER = '/kit/deploys/ledger.jsonl';
const STEP: RecordedStep = { session: 'po', what: 'build', request: { command: 'npm run build', cwd: '/app', env: {}, timeoutMs: 60_000 } };

function world(): { files: MemoryFiles; clock: FakeClock; steps: FakeSteps; ports: Parameters<typeof runRecorded>[0] } {
  const files = new MemoryFiles();
  const clock = new FakeClock('2030-01-08T10:00:00Z');
  const steps = new FakeSteps(clock);
  return { files, clock, steps, ports: { files, clock, steps, newId: () => 'step-1' } };
}

function records(files: MemoryFiles): unknown[] {
  return (files.get(LEDGER) ?? '').split('\n').filter((line) => line !== '').map((line): unknown => JSON.parse(line));
}

describe('runRecorded', () => {
  it('records the start, runs the step and records its end with its exit code', async () => {
    const { files, steps, ports } = world();
    steps.ends(3, 90_000);
    assert.deepEqual(await runRecorded(ports, LEDGER, STEP), { kind: 'exited', code: 3 });
    assert.deepEqual(steps.ran, [STEP.request]);
    const start = { type: 'heavy', id: 'step-1', session: 'po', what: 'build', kit: KIT_VERSION, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(records(files), [start, { ...start, endedAt: '2030-01-08T10:01:30.000Z', exitCode: 3 }]);
  });

  it('records a step that could not start as exit 1 and passes its error on', async () => {
    const { files, steps, ports } = world();
    steps.failsWith(new Error('no such folder'));
    await assert.rejects(runRecorded(ports, LEDGER, STEP), /no such folder/);
    assert.equal(records(files).length, 2);
    assert.deepEqual(records(files)[1], { type: 'heavy', id: 'step-1', session: 'po', what: 'build', kit: KIT_VERSION, startedAt: '2030-01-08T10:00:00.000Z', endedAt: '2030-01-08T10:00:00.000Z', exitCode: NOT_STARTED_EXIT });
  });

  it('records when the step began to wait, and its memory on the end record, from a watch of its tree', async () => {
    const { files, steps, ports } = world();
    steps.ends(0, 60_000);
    const memory = new FakeHostMemory().measures({ peakTreeMb: 2400, lowFreeMb: 6100 });
    const queued = { ...STEP, queuedAt: Date.parse('2030-01-08T09:58:00Z') };
    await runRecorded(ports, LEDGER, queued, { memory, root: 4242, intervalMs: 15_000 });
    assert.deepEqual(memory.watches, [{ root: 4242, intervalMs: 15_000, stopped: true }]);
    const start = { type: 'heavy', id: 'step-1', session: 'po', what: 'build', kit: KIT_VERSION, queuedAt: '2030-01-08T09:58:00.000Z', startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(records(files), [start, { ...start, endedAt: '2030-01-08T10:01:00.000Z', exitCode: 0, peakTreeMb: 2400, lowFreeMb: 6100 }]);
  });

  it('stops the watch of a step that could not start, and records what it measured', async () => {
    const { files, steps, ports } = world();
    steps.failsWith(new Error('no such folder'));
    const memory = new FakeHostMemory().measures({ lowFreeMb: 7000 });
    await assert.rejects(runRecorded(ports, LEDGER, STEP, { memory, root: 4242, intervalMs: 15_000 }), /no such folder/);
    assert.equal(memory.watches[0]?.stopped, true);
    assert.deepEqual(records(files)[1], { type: 'heavy', id: 'step-1', session: 'po', what: 'build', kit: KIT_VERSION, startedAt: '2030-01-08T10:00:00.000Z', endedAt: '2030-01-08T10:00:00.000Z', exitCode: NOT_STARTED_EXIT, lowFreeMb: 7000 });
  });
});

describe('recordQueuedStep', () => {
  it('records work of any kind as one step, its exit code read from what it returns', async () => {
    const { files, clock, ports } = world();
    const work = async (): Promise<{ readonly failedAt: string }> => {
      clock.advance(30_000);
      return { failedAt: 'pull' };
    };
    assert.deepEqual(await recordQueuedStep(ports, LEDGER, { session: 'po', what: 'deploy app' }, work, () => 4), { failedAt: 'pull' });
    const start = { type: 'heavy', id: 'step-1', session: 'po', what: 'deploy app', kit: KIT_VERSION, startedAt: '2030-01-08T10:00:00.000Z', endedAt: null, exitCode: null };
    assert.deepEqual(records(files), [start, { ...start, endedAt: '2030-01-08T10:00:30.000Z', exitCode: 4 }]);
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
