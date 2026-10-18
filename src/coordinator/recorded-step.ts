import type { Files } from '../core/files.ts';
import type { Clock } from '../core/lock.ts';
import { appendHeavy, type HeavyRecord } from './ledger.ts';
import { exitCodeOf, type StepEnd, type StepRequest, type StepRunner } from './steps.ts';

/** The exit code recorded for a step that could not start, as a missing folder makes it. */
export const NOT_STARTED_EXIT = 1;

export interface HeavyRecordPorts {
  readonly files: Files;
  readonly clock: Clock;
  newId(): string;
}

export interface RecordedStepPorts extends HeavyRecordPorts {
  readonly steps: StepRunner;
}

/** A heavy step as the ledger names it. */
export interface HeavyMark {
  readonly session: string;
  readonly what: string;
}

/** One heavy step as the ledger names it, and how to run it. */
export interface RecordedStep extends HeavyMark {
  readonly request: StepRequest;
}

/**
 * Runs `work` as one heavy step, its start and its end each a ledger record, the end with the exit code `exitOf`
 * reads from its result; work that throws is recorded as exit 1 and its error rethrown.
 */
export async function recordHeavy<T>(ports: HeavyRecordPorts, ledger: string, mark: HeavyMark, work: () => Promise<T>, exitOf: (result: T) => number): Promise<T> {
  const start: HeavyRecord = {
    type: 'heavy',
    id: ports.newId(),
    session: mark.session,
    what: mark.what,
    startedAt: new Date(ports.clock.now()).toISOString(),
    endedAt: null,
    exitCode: null,
  };
  await appendHeavy(ports.files, ledger, start);
  let exitCode = NOT_STARTED_EXIT;
  try {
    const result = await work();
    exitCode = exitOf(result);
    return result;
  } finally {
    const endedAt = new Date(ports.clock.now()).toISOString();
    await appendHeavy(ports.files, ledger, { ...start, endedAt, exitCode });
  }
}

/** Runs a heavy step, its start and its end each a ledger record; a step that could not start is recorded as exit 1 and its error rethrown. */
export async function runRecorded(ports: RecordedStepPorts, ledger: string, step: RecordedStep): Promise<StepEnd> {
  return recordHeavy(ports, ledger, step, () => ports.steps.run(step.request), exitCodeOf);
}
