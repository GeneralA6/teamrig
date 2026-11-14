import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord, numberField, stringField } from '../core/guards.ts';

/** The suffix of a detached run's record, beside its log in the detached folder (`detachedDirOf`). */
export const RUN_RECORD_SUFFIX = '.run.json';

/**
 * A detached run (`teamrig queue --detached-run`) still going: written by the run first thing, rewritten when its
 * step gets its turn, and removed by whichever reports its end first, the run itself or a sweep that finds its process
 * gone (T2742), so a run that dies with no end of its own is still told to its session.
 */
export interface DetachedRunRecord {
  readonly v: 1;
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
  if (!isRecord(value) || value['v'] !== 1) {
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
  return { v: 1, id, team, session, what, log, pid, startedAt, ...(runningAt === undefined ? {} : { runningAt }) };
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
