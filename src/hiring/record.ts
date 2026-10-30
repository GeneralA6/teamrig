import { isEffortLevel, type EffortLevel } from '../config/types.ts';
import { stringField, type JsonRecord } from '../core/guards.ts';
import { parseJsonl } from '../core/jsonl.ts';
import { parseUtcDay } from '../core/time.ts';

/**
 * The team's hires, keeps and retires, an append-only log: who joined for what job, on whose say-so, until which
 * review day, for which burst if any; who kept it on to a later review day, and why; and who left, with which
 * handover and to which heir. A session whose newest hire or retire is a hire is a hired session.
 */

/**
 * The format of the hire log's records; a newer one is skipped on read and refuses a write. Format 2 dropped the
 * hire's fixed `dailyPct`, so a teamrig that still requires it refuses to write beside a hire it cannot read. A keep
 * needs no new format: an older teamrig skips it as a damaged line, so it only misses the new review day.
 */
export const HIRE_FORMAT = 2;

/** The formats read: a hire stays on the team for weeks, so a format-1 hire still counts, its `dailyPct` ignored. */
const READ_FORMATS: readonly number[] = [1, HIRE_FORMAT];

export interface HireRecord {
  readonly kind: 'hire';
  readonly session: string;
  /** The job it was hired for. */
  readonly scope: string;
  readonly reason: string;
  /** Who approved it, under `hiring.policy` `owner`. */
  readonly approvedBy?: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  /** The day its hire is reviewed, `YYYY-MM-DD` (UTC). */
  readonly reviewBy: string;
  /** The `at` of the burst it was hired for (`hire --burst`): it is due to retire once that burst is over. */
  readonly burst?: number;
  /** The session that hired it. */
  readonly by: string;
  readonly at: number;
}

export interface RetireRecord {
  readonly kind: 'retire';
  readonly session: string;
  readonly reason: string;
  /** The handover it left. */
  readonly handover?: string;
  /** Why it left none, when it did not. */
  readonly noHandover?: string;
  /** The session its open tasks went to. */
  readonly heir?: string;
  readonly by: string;
  readonly at: number;
}

/** A hired session kept on the team to a new review day (`hire <id> --review <day>`), its job and launch unchanged. */
export interface KeepRecord {
  readonly kind: 'keep';
  readonly session: string;
  /** Its new review day, `YYYY-MM-DD` (UTC). */
  readonly reviewBy: string;
  /** Why the team still needs it. */
  readonly reason: string;
  /** The lead over it that kept it. */
  readonly by: string;
  readonly at: number;
}

export type HiringRecord = HireRecord | RetireRecord | KeepRecord;

export function isHire(record: HiringRecord): record is HireRecord {
  return record.kind === 'hire';
}

function isRetire(record: HiringRecord): record is RetireRecord {
  return record.kind === 'retire';
}

function isKeep(record: HiringRecord): record is KeepRecord {
  return record.kind === 'keep';
}

/**
 * Each session's newest hire or retire, in the order the sessions first appear. A keep moves the review day of the
 * hire it follows; one after a retire, or before any hire, keeps nothing.
 */
function newestBySession(records: readonly HiringRecord[]): Array<HireRecord | RetireRecord> {
  const newest = new Map<string, HireRecord | RetireRecord>();
  for (const record of records) {
    if (!isKeep(record)) {
      newest.set(record.session, record);
      continue;
    }
    const kept = newest.get(record.session);
    if (kept !== undefined && isHire(kept)) {
      newest.set(record.session, { ...kept, reviewBy: record.reviewBy });
    }
  }
  return [...newest.values()];
}

/**
 * The sessions hired and not retired since, each with its newest hire at the review day of its newest keep, in the
 * order they were first hired.
 */
export function activeHires(records: readonly HiringRecord[]): HireRecord[] {
  return newestBySession(records).filter(isHire);
}

/** The sessions retired and not hired again since, each with its retire, in the order they first appear. */
export function retiredSessions(records: readonly HiringRecord[]): RetireRecord[] {
  return newestBySession(records).filter(isRetire);
}

/**
 * The retire a hired session came back from: the retire before its newest hire, when that hire is a rehire of a
 * retired id. Undefined for a first hire, a retired session, or an id with no record.
 */
export function rehiredFrom(records: readonly HiringRecord[], session: string): RetireRecord | undefined {
  let retire: RetireRecord | undefined;
  let from: RetireRecord | undefined;
  for (const record of records) {
    if (record.session !== session) {
      continue;
    }
    if (isHire(record)) {
      from = retire;
    } else if (isRetire(record)) {
      retire = record;
      from = undefined;
    }
  }
  return from;
}

function instantOf(record: JsonRecord, key: string): number | undefined {
  const text = stringField(record, key);
  const at = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

/** One record as a hire, a keep or a retire; undefined when it is damaged. */
export function parseHiringRecord(record: JsonRecord): HiringRecord | undefined {
  const session = stringField(record, 'session');
  const reason = stringField(record, 'reason');
  const by = stringField(record, 'by');
  const at = instantOf(record, 'at');
  if (session === undefined || reason === undefined || by === undefined || at === undefined) {
    return undefined;
  }
  if (record['kind'] === 'keep') {
    const reviewBy = stringField(record, 'reviewBy');
    return reviewBy === undefined || parseUtcDay(reviewBy) === undefined ? undefined : { kind: 'keep', session, reviewBy, reason, by, at };
  }
  if (record['kind'] === 'retire') {
    const handover = stringField(record, 'handover');
    const noHandover = stringField(record, 'noHandover');
    const heir = stringField(record, 'heir');
    return {
      kind: 'retire',
      session,
      reason,
      by,
      at,
      ...(handover === undefined ? {} : { handover }),
      ...(noHandover === undefined ? {} : { noHandover }),
      ...(heir === undefined ? {} : { heir }),
    };
  }
  const scope = stringField(record, 'scope');
  const reviewBy = stringField(record, 'reviewBy');
  const effort = record['effort'];
  const approvedBy = stringField(record, 'approvedBy');
  const model = stringField(record, 'model');
  const burst = instantOf(record, 'burst');
  if (record['burst'] !== undefined && burst === undefined) {
    return undefined;
  }
  if (record['kind'] !== 'hire' || scope === undefined || reviewBy === undefined || parseUtcDay(reviewBy) === undefined) {
    return undefined;
  }
  if (effort !== undefined && !isEffortLevel(effort)) {
    return undefined;
  }
  return {
    kind: 'hire',
    session,
    scope,
    reason,
    ...(approvedBy === undefined ? {} : { approvedBy }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    reviewBy,
    ...(burst === undefined ? {} : { burst }),
    by,
    at,
  };
}

export interface HiringLogRead {
  readonly records: readonly HiringRecord[];
  /** Damaged lines and lines from a newer teamrig, skipped. */
  readonly skipped: number;
}

/** A hire log's text as its records, oldest first; damaged lines and lines from a newer teamrig are skipped. */
export function readHiringLog(text: string): HiringLogRead {
  const parse = parseJsonl(text);
  const records: HiringRecord[] = [];
  for (const { record, version } of parse.records) {
    const parsed = READ_FORMATS.includes(version) ? parseHiringRecord(record) : undefined;
    if (parsed !== undefined) {
      records.push(parsed);
    }
  }
  return { records, skipped: parse.unreadable + parse.records.length - records.length };
}
