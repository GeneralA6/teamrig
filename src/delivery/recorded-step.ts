import type { QueueConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { Clock } from '../core/lock.ts';
import { KIT_VERSION } from '../core/version.ts';
import { appendRecord, type QueuedStepRecord, type RefusalOutcome } from './ledger.ts';
import { holdersText, type HostMemory, type MemoryPeaks } from './memory.ts';
import type { DeliveryPlaces } from './places.ts';
import { processRequest, type ProcessRequest } from './process-request.ts';
import { exitCodeOf, STOPPED_EXIT, TIMED_OUT_EXIT, type StepEnd, type StepRequest, type StepRunner } from './steps.ts';
import type { WaitCause, Waited, WaitLog, WaitTotals } from './wait-log.ts';

/** The exit code recorded for a step that could not start, as a missing folder makes it. */
export const NOT_STARTED_EXIT = 1;

/**
 * What every recorder of a queued step holds: the files, the clock and the host's memory, so no caller can record a
 * step without watching it (a merge or a deploy once did, and its exit-129 ends carried no memory).
 */
export interface StepRecordPorts {
  readonly files: Files;
  readonly clock: Clock;
  /**
   * A watch of the step's process tree while it runs, the host's free memory and commit charge when it is killed, and
   * the programs holding the most memory when it is refused after a wait on memory (`recordRefusal`).
   */
  readonly memory: Pick<HostMemory, 'watch' | 'freeMb' | 'commit' | 'holders'>;
  /** This process's id: the root of the tree every step it runs starts in. */
  readonly pid: number;
  newId(): string;
}

export interface RecordedStepPorts extends StepRecordPorts {
  readonly steps: StepRunner;
}

/** Where a queued step is recorded, and how often its memory is sampled: the delivery setup the step runs under. */
export interface StepRecordSetup {
  readonly places: Pick<DeliveryPlaces, 'ledger'>;
  readonly delivery: { readonly queue: Pick<QueueConfig, 'memorySampleSeconds'> };
}

/**
 * Who asks for a queued step and what for: its session and its request (kind, task, priority), carried by its start,
 * end and refusal records. The kind is required, so no caller records a step without naming it.
 */
export interface StepOwner extends ProcessRequest {
  readonly session: string;
}

/** A queued step as the ledger names it. */
export interface StepMark extends StepOwner {
  readonly what: string;
  /** When the step began to wait for the host lock, in ms; recorded as `queuedAt`. */
  readonly queuedAt?: number;
  /** The ms it waited by cause (see `WaitLog`); recorded as `waits` when it waited on any. */
  readonly waits?: WaitTotals;
  /** The host's free memory when it began to wait, in MB; recorded as `queueFreeMb`. */
  readonly queueFreeMb?: number;
  /** Set for a small step sharing the host; recorded as `shared`. */
  readonly shared?: true;
}

/**
 * Marks for the queued steps one taking of the host lock runs, in order: only the first carries the taking's wait (when
 * it began, the ms by cause and the host's free memory then), since a later step's wait would count the steps before it.
 */
export function marksOfTaking(owner: StepOwner, waited: Waited): (what: string) => StepMark {
  let first: Waited | undefined = waited;
  return (what) => {
    const mark: StepMark = first === undefined ? { ...owner, what } : { ...owner, what, ...first };
    first = undefined;
    return mark;
  };
}

/** An owner's request as its records store it: `kind`, and `task` and its `priority` when it names them. */
function requestFieldsOf(owner: StepOwner): Pick<QueuedStepRecord, 'kind' | 'task' | 'priority'> {
  return processRequest(owner.kind, owner.task, owner.priority);
}

/** A mark's wait as the start record stores it: `queuedAt` as an ISO time, `waits` only when any cause took time. */
function waitFieldsOf(mark: StepMark): Pick<QueuedStepRecord, 'queuedAt' | 'waits' | 'queueFreeMb'> {
  return {
    ...(mark.queuedAt === undefined ? {} : { queuedAt: new Date(mark.queuedAt).toISOString() }),
    ...(mark.waits === undefined || Object.keys(mark.waits).length === 0 ? {} : { waits: mark.waits }),
    ...(mark.queueFreeMb === undefined ? {} : { queueFreeMb: mark.queueFreeMb }),
  };
}

/** One queued step as the ledger names it, and how to run it. */
export interface RecordedStep extends StepMark {
  readonly request: StepRequest;
}

/** The end of a step the kit killed, at its time limit or as its launching shell ended, or that a shell reports so. */
function killed(exitCode: number): boolean {
  return exitCode === TIMED_OUT_EXIT || exitCode === STOPPED_EXIT;
}

/** The host's memory at a kill: its free memory and, where the host reads it, its commit charge. */
async function atKill(memory: StepRecordPorts['memory']): Promise<Pick<QueuedStepRecord, 'endFreeMb' | 'commitMb' | 'commitLimitMb'>> {
  const endFreeMb = memory.freeMb();
  const charge = await memory.commit();
  return charge === undefined ? { endFreeMb } : { endFreeMb, commitMb: charge.usedMb, commitLimitMb: charge.limitMb };
}

/**
 * Runs `work` as one queued step, its start and its end each a ledger record naming this teamrig's version, the end
 * with the exit code `exitOf` reads from its result; work that throws is recorded as exit 1 and its error rethrown.
 * Unless `memorySampleSeconds` is 0, the tree of `pid` is watched while it runs: the end record carries the most it
 * held, the host's free memory at the start and at its least, and for a killed step (exit 124 or 129) the free memory
 * and commit charge at the kill.
 */
export async function recordQueuedStep<T>(ports: StepRecordPorts, setup: StepRecordSetup, mark: StepMark, work: () => Promise<T>, exitOf: (result: T) => number): Promise<T> {
  const ledger = setup.places.ledger;
  const sampleMs = setup.delivery.queue.memorySampleSeconds * 1_000;
  const start: QueuedStepRecord = {
    type: 'heavy',
    id: ports.newId(),
    session: mark.session,
    what: mark.what,
    ...requestFieldsOf(mark),
    kit: KIT_VERSION,
    ...waitFieldsOf(mark),
    ...(mark.shared === true ? { shared: true } : {}),
    startedAt: new Date(ports.clock.now()).toISOString(),
    endedAt: null,
    exitCode: null,
  };
  await appendRecord(ports.files, ledger, start);
  const watching = sampleMs === 0 ? undefined : ports.memory.watch(ports.pid, sampleMs);
  let exitCode = NOT_STARTED_EXIT;
  try {
    const result = await work();
    exitCode = exitOf(result);
    return result;
  } finally {
    const peaks: MemoryPeaks = (await watching?.stop()) ?? {};
    const kill = watching !== undefined && killed(exitCode) ? await atKill(ports.memory) : {};
    const endedAt = new Date(ports.clock.now()).toISOString();
    await appendRecord(ports.files, ledger, { ...start, endedAt, exitCode, ...peaks, ...kill });
  }
}

/** What a refusal's recorder holds: the ledger's files, the clock, and the host's free memory and memory holders. */
export interface RefusalRecordPorts {
  readonly files: Pick<Files, 'append'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly memory: Pick<HostMemory, 'freeMb' | 'holders'>;
  newId(): string;
}

/** The waits on host memory: a refusal after one names the programs holding the most, since most of it is held outside the queue. */
const MEMORY_CAUSES: ReadonlySet<WaitCause> = new Set(['memory', 'commit']);

/** `reason` with the host's top memory holders after it; unchanged when they cannot be listed. */
async function withHolders(reason: string, memory: RefusalRecordPorts['memory']): Promise<string> {
  const holders = await memory.holders();
  const named = holders === undefined ? undefined : holdersText(holders);
  return named === undefined ? reason : `${reason}; ${named}`;
}

/** A queued step that did not run, as its refusal record names it. */
export interface RefusalMark extends StepOwner {
  readonly what: string;
  readonly outcome: RefusalOutcome;
  readonly reason: string;
}

/**
 * Records a queued step that waited and then did not run: its wait by cause, the last reason it waited on, and the
 * host's free memory when it began to wait and when it ended. Returns the reason to print, as recorded: when the last
 * wait was on host memory, the mark's reason with the top memory holders after it. A step refused before anything held
 * it (the cutoff before it queued, a refusing check at the first ask) records nothing, it never waited, and keeps the
 * mark's reason.
 */
export async function recordRefusal(ports: RefusalRecordPorts, ledger: string, waits: WaitLog, mark: RefusalMark): Promise<string> {
  const lastWait = waits.last();
  if (lastWait === undefined) {
    return mark.reason;
  }
  const waited = waits.end();
  const reason = MEMORY_CAUSES.has(lastWait.cause) ? await withHolders(mark.reason, ports.memory) : mark.reason;
  await appendRecord(ports.files, ledger, {
    type: 'refusal',
    id: ports.newId(),
    session: mark.session,
    what: mark.what,
    ...requestFieldsOf(mark),
    kit: KIT_VERSION,
    queuedAt: new Date(waited.queuedAt).toISOString(),
    endedAt: new Date(ports.clock.now()).toISOString(),
    outcome: mark.outcome,
    reason,
    ...(Object.keys(waited.waits).length === 0 ? {} : { waits: waited.waits }),
    lastWait,
    ...(waited.queueFreeMb === undefined ? {} : { queueFreeMb: waited.queueFreeMb }),
    endFreeMb: ports.memory.freeMb(),
  });
  return reason;
}

/** Runs a queued step as `recordQueuedStep` records it; a step that could not start is recorded as exit 1 and its error rethrown. */
export async function runRecorded(ports: RecordedStepPorts, setup: StepRecordSetup, step: RecordedStep): Promise<StepEnd> {
  return recordQueuedStep(ports, setup, step, () => ports.steps.run(step.request), exitCodeOf);
}
