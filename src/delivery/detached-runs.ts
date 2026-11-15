import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord, numberField, stringField } from '../core/guards.ts';
import { parseQueuedStep, type QueuedStepRecord } from './ledger.ts';

/** The suffix of a detached run's record, beside its log in the detached folder (`detachedDirOf`). */
export const RUN_RECORD_SUFFIX = '.run.json';

/**
 * The run record's format: 2 added `step` (T2942). Format 1 is still read, as it has the same fields less that one; an
 * older teamrig reads a format 2 record as none, so it leaves that run's death to a newer sweep: told late, never falsely.
 */
export const RUN_RECORD_FORMAT = 2;

/**
 * A detached run (`teamrig queue --detached-run`) still going: written by the run first thing, rewritten when its
 * step gets its turn, and removed by whichever reports its end first, the run itself or a sweep that finds its process
 * gone (T2742), so a run that dies with no end of its own is still told to its session.
 */
export interface DetachedRunRecord {
  readonly v: typeof RUN_RECORD_FORMAT;
  readonly id: string;
  /** The team whose run it is: the detached folder may be shared by every team pointing `delivery.dir` at one place. */
  readonly team: string;
  readonly session: string;
  readonly what: string;
  readonly log: string;
  /** The run's own process. */
  readonly pid: number;
  /** An ISO time: when the run began to wait for its turn. */
  readonly startedAt: string;
  /** An ISO time: when its step got its turn and began to run. */
  readonly runningAt?: string;
  /**
   * Its step's start record and the ledger it is in, once there: what a sweep closes when the run dies (T2942). The
   * start record is the ledger's queued step record as `parseQueuedStep` reads it, so a field that record gains is
   * a new format of this one too.
   */
  readonly step?: LedgerStep;
}

/** A queued step's start record and the ledger that holds it. */
export interface LedgerStep {
  readonly ledger: string;
  readonly start: QueuedStepRecord;
}

/** The exit code a sweep records for a step whose run died, as `exitCodeOf` records one a signal stopped. */
export const DIED_EXIT = 1;

/**
 * The end record of a step whose run died while it ran, under its start's id: the death was seen at `endedAt`, a sweep's
 * time, so the end is late by at most the time between sweeps, never early.
 */
export function diedEndOf(start: QueuedStepRecord, endedAt: string): QueuedStepRecord {
  return { ...start, endedAt, exitCode: DIED_EXIT };
}

/** The record of the detached run `id` in the detached folder `dir`. */
export function runRecordPathOf(dir: string, id: string): string {
  return join(dir, `${id}${RUN_RECORD_SUFFIX}`);
}

export function formatRunRecord(record: DetachedRunRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** The record in `text`, or undefined when it is not one (a torn or foreign file is left for no one to report). */
export function parseRunRecord(text: string): DetachedRunRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || (value['v'] !== 1 && value['v'] !== RUN_RECORD_FORMAT)) {
    return undefined;
  }
  const [id, team, session, what, log, startedAt, pid] = [
    stringField(value, 'id'),
    stringField(value, 'team'),
    stringField(value, 'session'),
    stringField(value, 'what'),
    stringField(value, 'log'),
    stringField(value, 'startedAt'),
    numberField(value, 'pid'),
  ];
  if (id === undefined || team === undefined || session === undefined || what === undefined || log === undefined || startedAt === undefined || pid === undefined || !Number.isSafeInteger(pid)) {
    return undefined;
  }
  const runningAt = stringField(value, 'runningAt');
  const step = value['v'] === RUN_RECORD_FORMAT ? ledgerStepOf(value['step']) : undefined;
  return { v: RUN_RECORD_FORMAT, id, team, session, what, log, pid, startedAt, ...(runningAt === undefined ? {} : { runningAt }), ...(step === undefined ? {} : { step }) };
}

/** `value` as a ledger step, or undefined when it is not one: a run whose step is unreadable is still told, only not closed. */
function ledgerStepOf(value: unknown): LedgerStep | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const [ledger, start] = [stringField(value, 'ledger'), parseQueuedStep(value['start'])];
  return ledger === undefined || start === undefined ? undefined : { ledger, start };
}

/** A run whose record is still there but whose process is gone: it died with no end of its own. */
export interface DeadRun {
  readonly path: string;
  readonly record: DetachedRunRecord;
}

/** What finding dead runs reads: the detached folder's files and whether a process is alive. */
export interface DeadRunPorts {
  readonly files: Pick<Files, 'list' | 'read'>;
  alive(pid: number): boolean;
}

/**
 * The runs of `team` in the detached folder `dir` whose process is gone. A reused pid makes a dead run look alive until
 * that process ends too: its death is told late, never falsely.
 */
export async function deadRunsOf(ports: DeadRunPorts, dir: string, team: string): Promise<DeadRun[]> {
  const dead: DeadRun[] = [];
  for (const name of await ports.files.list(dir)) {
    if (!name.endsWith(RUN_RECORD_SUFFIX)) {
      continue;
    }
    const path = join(dir, name);
    const text = await ports.files.read(path);
    const record = text === undefined ? undefined : parseRunRecord(text);
    if (record !== undefined && record.team === team && !ports.alive(record.pid)) {
      dead.push({ path, record });
    }
  }
  return dead;
}

/** The line a dead run's session hears: what died, at which stage, and that nothing will report its end. */
export function diedText(record: DetachedRunRecord): string {
  const stage = record.runningAt === undefined ? 'while it waited for its turn' : 'while its step ran';
  return `queue ${record.id} died ${stage}: ${record.what}: its process (pid ${record.pid}) ended with no end of its own, so nothing else reports it; re-run it; log ${record.log}`;
}
