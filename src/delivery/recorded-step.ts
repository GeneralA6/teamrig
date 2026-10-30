import type { Files } from '../core/files.ts';
import type { Clock } from '../core/lock.ts';
import { KIT_VERSION } from '../core/version.ts';
import { appendRecord, type QueuedStepRecord } from './ledger.ts';
import type { HostMemory } from './memory.ts';
import { exitCodeOf, type StepEnd, type StepRequest, type StepRunner } from './steps.ts';

/** The exit code recorded for a step that could not start, as a missing folder makes it. */
export const NOT_STARTED_EXIT = 1;

export interface StepRecordPorts {
  readonly files: Files;
  readonly clock: Clock;
  newId(): string;
}

export interface RecordedStepPorts extends StepRecordPorts {
  readonly steps: StepRunner;
}

/** A queued step as the ledger names it. */
export interface StepMark {
  readonly session: string;
  readonly what: string;
  /** When the step began to wait for the host lock, in ms; recorded as `queuedAt`. */
  readonly queuedAt?: number;
  /** Set for a small step sharing the host; recorded as `shared`. */
  readonly shared?: true;
}

/** How a step's memory is watched while it runs: the host's memory, the root of its process tree, and how often. */
export interface StepWatch {
  readonly memory: Pick<HostMemory, 'watch'>;
  readonly root: number;
  readonly intervalMs: number;
}

/**
 * Marks for the queued steps one taking of the host lock runs, in order: only the first carries `queuedAt`, when the
 * taking began to wait, since a later step's wait would count the steps before it.
 */
export function marksOfTaking(session: string, queuedAt: number): (what: string) => StepMark {
  let waited: number | undefined = queuedAt;
  return (what) => {
    const mark: StepMark = waited === undefined ? { session, what } : { session, what, queuedAt: waited };
    waited = undefined;
    return mark;
  };
}

/** One queued step as the ledger names it, and how to run it. */
export interface RecordedStep extends StepMark {
  readonly request: StepRequest;
}

/**
 * Runs `work` as one queued step, its start and its end each a ledger record naming this teamrig's version, the end
 * with the exit code `exitOf` reads from its result; work that throws is recorded as exit 1 and its error rethrown.
 * With `watch`, the end record carries the most the step's process tree held and the least free memory the host had
 * while it ran.
 */
export async function recordQueuedStep<T>(ports: StepRecordPorts, ledger: string, mark: StepMark, work: () => Promise<T>, exitOf: (result: T) => number, watch?: StepWatch): Promise<T> {
  const start: QueuedStepRecord = {
    type: 'heavy',
    id: ports.newId(),
    session: mark.session,
    what: mark.what,
    kit: KIT_VERSION,
    ...(mark.queuedAt === undefined ? {} : { queuedAt: new Date(mark.queuedAt).toISOString() }),
    ...(mark.shared === true ? { shared: true } : {}),
    startedAt: new Date(ports.clock.now()).toISOString(),
    endedAt: null,
    exitCode: null,
  };
  await appendRecord(ports.files, ledger, start);
  const watching = watch?.memory.watch(watch.root, watch.intervalMs);
  let exitCode = NOT_STARTED_EXIT;
  try {
    const result = await work();
    exitCode = exitOf(result);
    return result;
  } finally {
    const peaks = (await watching?.stop()) ?? {};
    const endedAt = new Date(ports.clock.now()).toISOString();
    await appendRecord(ports.files, ledger, { ...start, endedAt, exitCode, ...peaks });
  }
}

/**
 * Runs a queued step, its start and its end each a ledger record, its memory watched with `watch`; a step that could
 * not start is recorded as exit 1 and its error rethrown.
 */
export async function runRecorded(ports: RecordedStepPorts, ledger: string, step: RecordedStep, watch?: StepWatch): Promise<StepEnd> {
  return recordQueuedStep(ports, ledger, step, () => ports.steps.run(step.request), exitCodeOf, watch);
}
