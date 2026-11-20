import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isStringArray } from '../core/guards.ts';
import { hostSessionOf } from '../core/host-session.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';

/** The format of the notice files this code writes; a file in a format it does not read reads as none told. */
export const MODEL_NOTICES_FORMAT = 1;
/**
 * The format a later teamrig writes, naming the tab `hostSession` where this one names it `claude` (T4762,
 * src/core/host-session.ts): read from now on and written by none yet, so every tab reads it before the first one
 * writes it.
 */
export const MODEL_NOTICES_NEXT_FORMAT = 2;

/** At most this many notices are remembered per Claude Code session; the oldest go first. */
export const MAX_TOLD = 20;

/** The model notices a team session was shown in one Claude Code session, so each shows once. */
export interface ToldNotices {
  /** The Claude Code session id; a new one (a /clear, a new start) starts the list over. */
  readonly claude: string;
  /** The notices' keys, oldest first. */
  readonly told: readonly string[];
}

/** A notice file's content; undefined when it is damaged or from a format this code does not read. */
export function parseToldNotices(text: string): ToldNotices | undefined {
  const record = parseObject(text.trim());
  if (record === undefined) {
    return undefined;
  }
  const format = record[VERSION_FIELD];
  if (format !== MODEL_NOTICES_FORMAT && format !== MODEL_NOTICES_NEXT_FORMAT) {
    return undefined;
  }
  const claude = hostSessionOf(record, 'claude');
  const told = record['told'];
  return claude === undefined || !isStringArray(told) ? undefined : { claude, told };
}

export function formatToldNotices(notices: ToldNotices): string {
  return toJsonlLine({ [VERSION_FIELD]: MODEL_NOTICES_FORMAT, claude: notices.claude, told: [...notices.told] });
}

/**
 * Which model notices each team session was already shown, one small file per session (`<id>.json`),
 * written only by that session's own Stop hook. Ids are session ids, checked by the roster, so they
 * are safe in a path.
 */
export class ModelNoticeStore {
  private readonly files: Files;
  private readonly folder: string;

  constructor(files: Files, folder: string) {
    this.files = files;
    this.folder = folder;
  }

  /** The keys shown to the session in this Claude Code session; none for another Claude Code session or a damaged file. */
  async told(id: string, claude: string): Promise<readonly string[]> {
    const text = await this.files.read(this.pathOf(id));
    const notices = text === undefined ? undefined : parseToldNotices(text);
    return notices === undefined || notices.claude !== claude ? [] : notices.told;
  }

  /** Adds `keys` to what this Claude Code session was told, keeping the newest `MAX_TOLD`. */
  async remember(id: string, claude: string, keys: readonly string[]): Promise<void> {
    const told = [...(await this.told(id, claude)), ...keys];
    await this.files.write(this.pathOf(id), formatToldNotices({ claude, told: told.slice(-MAX_TOLD) }));
  }

  private pathOf(id: string): string {
    return join(this.folder, `${id}.json`);
  }
}
