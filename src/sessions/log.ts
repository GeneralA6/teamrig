import { isNonNegativeInteger, stringField, type JsonRecord } from '../core/guards.ts';
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';

/**
 * The team's session closes and reopens, an append-only log (`<state>/session-log.jsonl`): which running session
 * `teamrig close` or the idle pass ended to free the host, who, how long it had been idle and what it held, and when
 * `teamrig open` started it again, resumed in its last Claude Code session or fresh. A session whose newest
 * record is a close is closed by teamrig. A newer format is skipped on read and refuses a write.
 * A close's `folder` (T1408) is no new format, as the register's optional fields are none (src/register/events.ts):
 * no teamrig rewrites this log, and an older one ignores it and reopens the session in the project, fresh when its
 * transcript is not there. A new format would instead fail an older tab's close after its tab ended, unlogged.
 * A home close (no `claudeSession`, T1364) is no new format either: an older teamrig skips it as damaged and sees its
 * session as never closed, so only its idle pass leaves it home.
 */
export const SESSION_LOG_FORMAT = 1;

/**
 * Where the log sits under the team's state folder (`<kit home>/teams/<team>/state`, unless the team config's
 * `paths.state` moves it), as `teamPaths` (src/core/home.ts) names it, for a reader that finds the file itself.
 */
export const SESSION_LOG_IN_STATE = ['session-log.jsonl'] as const;

export interface CloseRecord {
  readonly kind: 'close';
  readonly session: string;
  /** Who closed it: the lead's session id, `idle-pass` for the idle pass, or for a home close the leader who hired it. */
  readonly by: string;
  /** ISO instant. */
  readonly at: string;
  /**
   * The Claude Code session it ran, which its reopen resumes; absent in a home close (T1364): a session hired with no
   * room on the host, which starts home, never having run, and opens as a new hire does.
   */
  readonly claudeSession?: string;
  /** How long its transcript had been quiet, in whole minutes; 0 in a home close. */
  readonly idleMinutes: number;
  /** What its Claude Code's process tree held, freed by the close; 0 in a home close. */
  readonly freedMb: number;
  /**
   * The folder its reopen resumes it in, the one whose project folder holds its transcript (T1408); absent in a close
   * logged before teamrig 0.211.0, which resumes in the team's project.
   */
  readonly folder?: string;
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
  if (record['kind'] !== 'close' || by === undefined || idleMinutes === undefined || freedMb === undefined) {
    return undefined;
  }
  const folder = stringField(record, 'folder');
  return { kind: 'close', session, by, at, ...(claudeSession === undefined ? {} : { claudeSession }), idleMinutes, freedMb, ...(folder === undefined ? {} : { folder }) };
}

/** The close that keeps a session hired with no room home until it has work and the host has room (T1364). */
export function homeCloseOf(session: string, by: string, at: string): CloseRecord {
  return { kind: 'close', session, by, at, idleMinutes: 0, freedMb: 0 };
}

function recordOf(record: SessionLogRecord): JsonRecord {
  return { [VERSION_FIELD]: SESSION_LOG_FORMAT, ...record };
}

/** The close a session is in: its newest record when that is a close; undefined once it was reopened, or never closed. */
export function closedOf(records: readonly SessionLogRecord[], session: string): CloseRecord | undefined {
  const newest = records.findLast((record) => record.session === session);
  return newest?.kind === 'close' ? newest : undefined;
}

/** Each session's records, oldest first, by session id: what a reader shows of one session's closes and reopens. */
export function sessionLogBySession(records: readonly SessionLogRecord[]): ReadonlyMap<string, readonly SessionLogRecord[]> {
  const bySession = new Map<string, SessionLogRecord[]>();
  for (const record of records) {
    const own = bySession.get(record.session);
    if (own === undefined) {
      bySession.set(record.session, [record]);
    } else {
      own.push(record);
    }
  }
  return bySession;
}

/** The log's text as its records, oldest first, with the damaged and newer lines it skipped counted. */
export function readSessionLog(text: string): SessionLogRead {
  const parse = parseJsonl(text);
  const records: SessionLogRecord[] = [];
  for (const { record, version } of parse.records) {
    const parsed = version === SESSION_LOG_FORMAT ? parseSessionLogRecord(record) : undefined;
    if (parsed !== undefined) {
      records.push(parsed);
    }
  }
  return { records, skipped: parse.unreadable + parse.records.length - records.length };
}

/**
 * The file calls the log makes, which `Files` (src/core/files.ts) gives. The log names only these, so the read side
 * (src/read/index.ts), which reaches no `node:` module, can export its records and `readSessionLog`.
 */
export interface SessionLogFiles {
  read(path: string): Promise<string | undefined>;
  append(path: string, text: string): Promise<void>;
}

/** The team's append-only log of session closes and reopens, oldest first. */
export class SessionLog {
  private readonly files: SessionLogFiles;
  readonly path: string;

  constructor(files: SessionLogFiles, path: string) {
    this.files = files;
    this.path = path;
  }

  async read(): Promise<SessionLogRead> {
    return readSessionLog((await this.files.read(this.path)) ?? '');
  }

  /** One whole line in one append; refused beside records from a newer teamrig. */
  async append(record: SessionLogRecord): Promise<void> {
    const text = (await this.files.read(this.path)) ?? '';
    assertWritable(this.path, parseJsonl(text), SESSION_LOG_FORMAT);
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    await this.files.append(this.path, `${separator}${toJsonlLine(recordOf(record))}`);
  }
}
