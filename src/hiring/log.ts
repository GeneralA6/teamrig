import { isEffortLevel, type EffortLevel } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { stringField, type JsonRecord } from '../core/guards.ts';
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { parseUtcDay } from '../core/time.ts';

/**
 * The team's hires and retires, an append-only log: who joined for what job, on whose say-so, until which
 * review day, for which burst if any, and who left, with which handover and to which heir. A session whose
 * newest record is a hire is a hired session.
 */

/**
 * The format of the hire log's records; a newer one is skipped on read and refuses a write. Format 2 dropped the
 * hire's fixed `dailyPct`, so a teamrig that still requires it refuses to write beside a hire it cannot read.
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

export type HiringRecord = HireRecord | RetireRecord;

function isHire(record: HiringRecord): record is HireRecord {
  return record.kind === 'hire';
}

function isRetire(record: HiringRecord): record is RetireRecord {
  return record.kind === 'retire';
}

/** Each session's newest record, in the order the sessions first appear. */
function newestBySession(records: readonly HiringRecord[]): HiringRecord[] {
  const newest = new Map<string, HiringRecord>();
  for (const record of records) {
    newest.set(record.session, record);
  }
  return [...newest.values()];
}

/** The sessions hired and not retired since, each with its newest hire, in the order they were first hired. */
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
    } else {
      retire = record;
      from = undefined;
    }
  }
  return from;
}

function recordOf(record: HiringRecord): JsonRecord {
  const base = { [VERSION_FIELD]: HIRE_FORMAT, kind: record.kind, session: record.session, reason: record.reason, by: record.by, at: new Date(record.at).toISOString() };
  if (!isHire(record)) {
    return {
      ...base,
      ...(record.handover === undefined ? {} : { handover: record.handover }),
      ...(record.noHandover === undefined ? {} : { noHandover: record.noHandover }),
      ...(record.heir === undefined ? {} : { heir: record.heir }),
    };
  }
  return {
    ...base,
    scope: record.scope,
    ...(record.approvedBy === undefined ? {} : { approvedBy: record.approvedBy }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.effort === undefined ? {} : { effort: record.effort }),
    reviewBy: record.reviewBy,
    ...(record.burst === undefined ? {} : { burst: new Date(record.burst).toISOString() }),
  };
}

function instantOf(record: JsonRecord, key: string): number | undefined {
  const text = stringField(record, key);
  const at = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

/** One record as a hire or a retire; undefined when it is damaged. */
export function parseHiringRecord(record: JsonRecord): HiringRecord | undefined {
  const session = stringField(record, 'session');
  const reason = stringField(record, 'reason');
  const by = stringField(record, 'by');
  const at = instantOf(record, 'at');
  if (session === undefined || reason === undefined || by === undefined || at === undefined) {
    return undefined;
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

/** The team's append-only log of hires and retires, `<state>/hires.jsonl`, oldest first. */
export class HiringLog {
  private readonly files: Files;
  readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<HiringLogRead> {
    const parse = parseJsonl((await this.files.read(this.path)) ?? '');
    const records: HiringRecord[] = [];
    for (const { record, version } of parse.records) {
      const parsed = READ_FORMATS.includes(version) ? parseHiringRecord(record) : undefined;
      if (parsed !== undefined) {
        records.push(parsed);
      }
    }
    return { records, skipped: parse.unreadable + parse.records.length - records.length };
  }

  /** One whole line in one append; refused beside records from a newer teamrig. */
  async append(record: HiringRecord): Promise<void> {
    const text = (await this.files.read(this.path)) ?? '';
    assertWritable(this.path, parseJsonl(text), HIRE_FORMAT);
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    await this.files.append(this.path, `${separator}${toJsonlLine(recordOf(record))}`);
  }
}
