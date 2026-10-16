import type { Files } from '../core/files.ts';
import { isNonNegativeInteger, isStringArray, stringField, type JsonRecord } from '../core/guards.ts';
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { isBurstKind, type Burst, type BurstEnd, type BurstRecord } from './burst.ts';

/**
 * The team's append-only log of bursts, `<state>/usage/bursts.jsonl`, oldest first: each burst the lead
 * starts, and the lead's end of one before its time. Instants are stored as ISO strings, like the lift log.
 */

/** The format of the burst log's records; a newer one is skipped on read and refuses a write. */
export const BURST_FORMAT = 1;

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** One burst or end as the log's JSON record. */
export function burstRecordOf(record: BurstRecord): JsonRecord {
  if (record.kind === 'end') {
    return { [VERSION_FIELD]: BURST_FORMAT, kind: 'end', burstAt: iso(record.burstAt), reason: record.reason, by: record.by, at: iso(record.at) };
  }
  return {
    [VERSION_FIELD]: BURST_FORMAT,
    kind: record.kind,
    sessions: record.sessions,
    helpers: record.helpers,
    hires: record.hires,
    dailyPct: record.dailyPct,
    stopPct: record.stopPct,
    endsAt: iso(record.endsAt),
    tasks: record.tasks,
    ...(record.deadline === undefined ? {} : { deadline: iso(record.deadline) }),
    reason: record.reason,
    ...(record.approvedBy === undefined ? {} : { approvedBy: record.approvedBy }),
    by: record.by,
    at: iso(record.at),
  };
}

function instantOf(record: JsonRecord, key: string): number | undefined {
  const text = stringField(record, key);
  const at = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}

function pctOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function parseEnd(record: JsonRecord): BurstEnd | undefined {
  const burstAt = instantOf(record, 'burstAt');
  const reason = stringField(record, 'reason');
  const by = stringField(record, 'by');
  const at = instantOf(record, 'at');
  return burstAt === undefined || reason === undefined || by === undefined || at === undefined ? undefined : { kind: 'end', burstAt, reason, by, at };
}

function parseStart(record: JsonRecord): Burst | undefined {
  const { kind, sessions, helpers, hires, tasks } = record;
  const dailyPct = pctOf(record['dailyPct']);
  const stopPct = pctOf(record['stopPct']);
  const endsAt = instantOf(record, 'endsAt');
  const reason = stringField(record, 'reason');
  const by = stringField(record, 'by');
  const at = instantOf(record, 'at');
  const deadline = instantOf(record, 'deadline');
  const approvedBy = stringField(record, 'approvedBy');
  if (
    !isBurstKind(kind) ||
    !isStringArray(sessions) ||
    !isNonNegativeInteger(helpers) ||
    !isNonNegativeInteger(hires) ||
    !isStringArray(tasks) ||
    dailyPct === undefined ||
    stopPct === undefined ||
    endsAt === undefined ||
    reason === undefined ||
    by === undefined ||
    at === undefined ||
    ('deadline' in record && deadline === undefined) ||
    ('approvedBy' in record && approvedBy === undefined)
  ) {
    return undefined;
  }
  return {
    kind,
    sessions,
    helpers,
    hires,
    dailyPct,
    stopPct,
    endsAt,
    tasks,
    ...(deadline === undefined ? {} : { deadline }),
    reason,
    ...(approvedBy === undefined ? {} : { approvedBy }),
    by,
    at,
  };
}

/** One record as a burst or an end; undefined when it is damaged. */
export function parseBurstRecord(record: JsonRecord): BurstRecord | undefined {
  return record['kind'] === 'end' ? parseEnd(record) : parseStart(record);
}

export interface BurstLogRead {
  readonly records: readonly BurstRecord[];
  /** Damaged lines and lines from a newer teamrig, skipped. */
  readonly skipped: number;
}

/** The team's append-only log of bursts and their ends, oldest first. */
export class BurstLog {
  private readonly files: Files;
  readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<BurstLogRead> {
    const parse = parseJsonl((await this.files.read(this.path)) ?? '');
    const records: BurstRecord[] = [];
    for (const { record, version } of parse.records) {
      const parsed = version === BURST_FORMAT ? parseBurstRecord(record) : undefined;
      if (parsed !== undefined) {
        records.push(parsed);
      }
    }
    return { records, skipped: parse.unreadable + parse.records.length - records.length };
  }

  /** One whole line in one append; refused beside records from a newer teamrig. */
  async append(record: BurstRecord): Promise<void> {
    const text = (await this.files.read(this.path)) ?? '';
    assertWritable(this.path, parseJsonl(text), BURST_FORMAT);
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    await this.files.append(this.path, `${separator}${toJsonlLine(burstRecordOf(record))}`);
  }
}
