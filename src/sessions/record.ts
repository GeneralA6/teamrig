import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isNonNegativeInteger, stringField } from '../core/guards.ts';
import type { TeamPaths } from '../core/home.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';

/** The format of the session record files this code reads and writes; a file in another format reads as absent. */
export const SESSION_RECORD_FORMAT = 1;

/**
 * Where a session last started, `<id>.json` each: its SessionStart hook records the Claude Code process its tab
 * runs in and that tab's Claude Code session at every start (a new tab, a /clear, a resume, a compaction). The
 * newest start overwrites the last, so the file names the tab the session runs in now, and once that process is
 * gone the session is closed.
 */
export interface SessionRecord {
  readonly claudePid: number;
  readonly claudeSession: string;
  /** When the hook recorded it, an ISO time (a record whose time does not parse is damaged). */
  readonly at: string;
}

/** A record file's content; undefined when it is damaged or from another format. */
export function parseSessionRecord(text: string): SessionRecord | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== SESSION_RECORD_FORMAT) {
    return undefined;
  }
  const claudePid = record['claudePid'];
  const claudeSession = stringField(record, 'claudeSession');
  const at = stringField(record, 'at');
  if (!isNonNegativeInteger(claudePid) || claudePid === 0 || claudeSession === undefined || at === undefined || Number.isNaN(Date.parse(at))) {
    return undefined;
  }
  return { claudePid, claudeSession, at };
}

export function formatSessionRecord(record: SessionRecord): string {
  return toJsonlLine({ [VERSION_FIELD]: SESSION_RECORD_FORMAT, ...record });
}

/** Each session's record. Ids are session ids, checked by the roster, so they are safe in a path. */
export class SessionRecordStore {
  private readonly files: Files;
  private readonly folder: string;

  constructor(files: Files, paths: Pick<TeamPaths, 'sessions'>) {
    this.files = files;
    this.folder = paths.sessions;
  }

  /** The session's record; undefined when it has none, or the file is damaged or from another format. */
  async read(id: string): Promise<SessionRecord | undefined> {
    const text = await this.files.read(this.pathOf(id));
    return text === undefined ? undefined : parseSessionRecord(text);
  }

  write(id: string, record: SessionRecord): Promise<void> {
    return this.files.write(this.pathOf(id), formatSessionRecord(record));
  }

  private pathOf(id: string): string {
    return join(this.folder, `${id}.json`);
  }
}
