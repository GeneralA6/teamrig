import type { Files } from '../core/files.ts';
import { isNonNegativeInteger, stringField, type JsonRecord } from '../core/guards.ts';
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';

/**
 * The team's session closes and reopens, an append-only log (`<state>/session-log.jsonl`): which running session
 * `teamrig close` or the idle pass ended to free the host, who, how long it had been idle and what it held, and when
 * `teamrig open` started it again, resumed in its last Claude Code session or fresh. A session whose newest
 * record is a close is closed by teamrig. A newer format is skipped on read and refuses a write.
 */
export const SESSION_LOG_FORMAT = 1;

export interface CloseRecord {
  readonly kind: 'close';
  readonly session: string;
  /** Who closed it: the lead's session id, or `idle-pass` for the idle pass. */
  readonly by: string;
  /** ISO instant. */
  readonly at: string;
  /** The Claude Code session it ran, which its reopen resumes. */
  readonly claudeSession: string;
  /** How long its transcript had been quiet, in whole minutes. */
  readonly idleMinutes: number;
  /** What its Claude Code's process tree held, freed by the close. */
  readonly freedMb: number;
}

export interface ReopenRecord {
  readonly kind: 'reopen';
  readonly session: string;
  /** ISO instant. */
  readonly at: string;
  /** The Claude Code session it resumed; absent when it opened fresh. */
  readonly resumed?: string;
}

export type SessionLogRecord = CloseRecord | ReopenRecord;

export interface SessionLogRead {
  readonly records: readonly SessionLogRecord[];
  /** Damaged lines and lines from a newer teamrig, skipped. */
  readonly skipped: number;
}

function instantField(record: JsonRecord, key: string): string | undefined {
  const value = stringField(record, key);
  return value !== undefined && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function integerField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return isNonNegativeInteger(value) ? value : undefined;
}

/** One record as written; undefined for a line that is not one. */
export function parseSessionLogRecord(record: JsonRecord): SessionLogRecord | undefined {
  const session = stringField(record, 'session');
  const at = instantField(record, 'at');
  if (session === undefined || at === undefined) {
    return undefined;
  }
  if (record['kind'] === 'reopen') {
    const resumed = stringField(record, 'resumed');
    return { kind: 'reopen', session, at, ...(resumed === undefined ? {} : { resumed }) };
  }
  const by = stringField(record, 'by');
  const claudeSession = stringField(record, 'claudeSession');
  const idleMinutes = integerField(record, 'idleMinutes');
  const freedMb = integerField(record, 'freedMb');
  if (record['kind'] !== 'close' || by === undefined || claudeSession === undefined || idleMinutes === undefined || freedMb === undefined) {
    return undefined;
  }
  return { kind: 'close', session, by, at, claudeSession, idleMinutes, freedMb };
}

function recordOf(record: SessionLogRecord): JsonRecord {
  return { [VERSION_FIELD]: SESSION_LOG_FORMAT, ...record };
}

/** The close a session is in: its newest record when that is a close; undefined once it was reopened, or never closed. */
export function closedOf(records: readonly SessionLogRecord[], session: string): CloseRecord | undefined {
  const newest = records.findLast((record) => record.session === session);
  return newest?.kind === 'close' ? newest : undefined;
}

/** The team's append-only log of session closes and reopens, oldest first. */
export class SessionLog {
  private readonly files: Files;
  readonly path: string;

  constructor(files: Files, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<SessionLogRead> {
    const parse = parseJsonl((await this.files.read(this.path)) ?? '');
    const records: SessionLogRecord[] = [];
    for (const { record, version } of parse.records) {
      const parsed = version === SESSION_LOG_FORMAT ? parseSessionLogRecord(record) : undefined;
      if (parsed !== undefined) {
        records.push(parsed);
      }
    }
    return { records, skipped: parse.unreadable + parse.records.length - records.length };
  }

  /** One whole line in one append; refused beside records from a newer teamrig. */
  async append(record: SessionLogRecord): Promise<void> {
    const text = (await this.files.read(this.path)) ?? '';
    assertWritable(this.path, parseJsonl(text), SESSION_LOG_FORMAT);
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    await this.files.append(this.path, `${separator}${toJsonlLine(recordOf(record))}`);
  }
}
