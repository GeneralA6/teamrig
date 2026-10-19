import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { ID_PATTERN } from '../core/ids.ts';
import { parseObject } from '../core/jsonl.ts';
import { formatEntry, parseEntry, type TurnLogEntry } from './entry.ts';

/** An hour's file name, `2026-10-19T09.jsonl`: sortable, and with no colon, which Windows refuses in a name. */
const HOUR_FILE = /^(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/u;
const HOUR_MS = 60 * 60_000;
/** Enough of an hour's file to hold its last entry, the longest reply included. */
const LAST_ENTRY_BYTES = 512 * 1024;

/** The UTC hour `at` falls in, as its file names it. */
export function hourOf(at: string): string {
  return new Date(at).toISOString().slice(0, 13);
}

/**
 * Each team session's prompts and replies for the last `keepHours` (`turnLog`), so the person can read what a
 * tab showed after a /clear wiped it: `<dir>/<session id>/<UTC hour>.jsonl`, one JSON line per entry
 * (`entry.ts`). An entry is only ever appended to its hour's file, and only an hour's file wholly past the kept
 * hours is removed, so no write ever rewrites a file another hook appends to. A reader still hides entries
 * older than `keepHours`, since the oldest file kept may hold some.
 */
export class TurnLog {
  private readonly files: Files;
  private readonly dir: string;

  constructor(files: Files, dir: string) {
    this.files = files;
    this.dir = dir;
  }

  append(id: string, entry: TurnLogEntry): Promise<void> {
    return this.files.append(join(this.dir, id, `${hourOf(entry.at)}.jsonl`), formatEntry(entry));
  }

  /** The session's last entry: the last readable line of its newest hour's file; undefined with none. */
  async last(id: string): Promise<TurnLogEntry | undefined> {
    const newest = (await this.hours(id)).at(-1);
    if (newest === undefined) {
      return undefined;
    }
    const tail = await this.files.readTail(join(this.dir, id, `${newest}.jsonl`), LAST_ENTRY_BYTES);
    const lines = tail?.split('\n') ?? [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = parseObject(lines[index]?.trim() ?? '');
      const entry = record === undefined ? undefined : parseEntry(record);
      if (entry !== undefined) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Removes every session's hour files that end before `now` less `keepHours`; returns how many went. It only
   * lists folders, so it is cheap at every session start.
   */
  async prune(now: number, keepHours: number): Promise<number> {
    const cutoff = now - keepHours * HOUR_MS;
    let removed = 0;
    // Only session folders: a stray file in the folder is no session, and listing it as one would throw.
    const ids = (await this.files.list(this.dir)).filter((name) => ID_PATTERN.test(name));
    for (const id of ids) {
      for (const hour of await this.hours(id)) {
        if (Date.parse(`${hour}:00:00Z`) + HOUR_MS <= cutoff) {
          await this.files.remove(join(this.dir, id, `${hour}.jsonl`));
          removed += 1;
        }
      }
    }
    return removed;
  }

  /** The session's hours with a file, oldest first. */
  private async hours(id: string): Promise<readonly string[]> {
    const names = await this.files.list(join(this.dir, id));
    return names.flatMap((name) => HOUR_FILE.exec(name)?.slice(1, 2) ?? []).sort();
  }
}
