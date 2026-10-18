import type { Files } from '../core/files.ts';
import type { Clock } from '../core/lock.ts';
import { appendHeavy, type HeavyRecord } from './ledger.ts';
import { exitCodeOf, type StepEnd, type StepRequest, type StepRunner } from './steps.ts';

/** The exit code recorded for a step that could not start, as a missing folder makes it. */
export const NOT_STARTED_EXIT = 1;

export interface RecordedStepPorts {
  readonly files: Files;
  readonly clock: Clock;
  readonly steps: StepRunner;
  newId(): string;
}

/** One heavy step as the ledger names it, and how to run it. */
export interface RecordedStep {
  readonly session: string;
  readonly what: string;
  readonly request: StepRequest;
}

/** Runs a heavy step, its start and its end each a ledger record; a step that could not start is recorded as exit 1 and its error rethrown. */
export async function runRecorded(ports: RecordedStepPorts, ledger: string, step: RecordedStep): Promise<StepEnd> {
  const start: HeavyRecord = {
    type: 'heavy',
    id: ports.newId(),
    session: step.session,
    what: step.what,
    startedAt: new Date(ports.clock.now()).toISOString(),
    endedAt: null,
    exitCode: null,
  };
  await appendHeavy(ports.files, ledger, start);
  let end: StepEnd | undefined;
  try {
    end = await ports.steps.run(step.request);
    return end;
  } finally {
    const endedAt = new Date(ports.clock.now()).toISOString();
    await appendHeavy(ports.files, ledger, { ...start, endedAt, exitCode: end === undefined ? NOT_STARTED_EXIT : exitCodeOf(end) });
  }
}
