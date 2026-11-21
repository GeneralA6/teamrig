import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { stringField } from '../core/guards.ts';
import { ID_PATTERN } from '../core/ids.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { sessionFileIn } from './registry.ts';

/**
 * The mark teamrig sets on each prompt it submits itself (#921), so the prompt hook tells a turn teamrig started from
 * one the owner did by where the prompt came from, never by its words: a prompt builder added later is marked as
 * soon as it goes through one of the two places that submit (`launch`'s first prompt, the wake check's answer), and a
 * typed prompt that quotes a builder's words stays the owner's. `hook restore-track` takes the mark at the prompt and
 * stamps the tab's restore entry with who prompted (src/restore/entry.ts), which `meeting end` reads.
 */

/** The format of a mark file; a file in another format reads as no mark. */
export const PROMPT_MARK_FORMAT = 1;

/**
 * Whom a mark is kept for: one Claude Code session (`tab`) when the submitter knows it (a wake, a resume), else the
 * team session a fresh `launch` starts, whose Claude Code session gets its id only once it runs.
 */
export type PromptMarkKey = { readonly tab: string } | { readonly team: string; readonly session: string };

/** The marks' folder, beside the restore's sessions folder: the hook that takes them follows every tab of the machine. */
export function promptMarksDir(kitHome: string): string {
  return join(kitHome, 'restore', 'prompts');
}

/**
 * One small file per key, holding the text teamrig submitted last and when, kept until a prompt in that tab or
 * session matches it. The match is exact, outer white space aside: a submitted text the person edited is theirs.
 * Only a Claude Code session id or two checked ids name a file, so no payload text reaches a path.
 */
export class PromptMarks {
  private readonly files: Files;
  private readonly dir: string;

  constructor(files: Files, dir: string) {
    this.files = files;
    this.dir = dir;
  }

  /** Marks `text` as teamrig's, in place of any earlier mark for the same key. */
  async mark(key: PromptMarkKey, text: string, at: number): Promise<void> {
    await this.files.write(this.pathOf(key), toJsonlLine({ [VERSION_FIELD]: PROMPT_MARK_FORMAT, text, at: new Date(at).toISOString() }));
  }

  /** The marked text for a key; undefined when there is none or its file is damaged or of another format. */
  async read(key: PromptMarkKey): Promise<string | undefined> {
    const raw = await this.files.read(this.pathOf(key));
    const record = raw === undefined ? undefined : parseObject(raw.trim());
    return record === undefined || record[VERSION_FIELD] !== PROMPT_MARK_FORMAT ? undefined : stringField(record, 'text');
  }

  /**
   * Whether `prompt` is a text teamrig marked under one of `keys`, in order. A match is removed, so a mark marks one
   * prompt only; of two hooks taking it at once, only the one that removed it is told true.
   */
  async take(keys: readonly PromptMarkKey[], prompt: string): Promise<boolean> {
    for (const key of keys) {
      if ((await this.read(key))?.trim() === prompt.trim()) {
        return this.files.remove(this.pathOf(key));
      }
    }
    return false;
  }

  /** Removes a key's mark: its prompt was dropped before it reached the tab. */
  async forget(key: PromptMarkKey): Promise<void> {
    await this.files.remove(this.pathOf(key));
  }

  private pathOf(key: PromptMarkKey): string {
    if ('tab' in key) {
      return sessionFileIn(this.dir, key.tab);
    }
    if (!ID_PATTERN.test(key.team) || !ID_PATTERN.test(key.session)) {
      throw new Error(`${JSON.stringify(`${key.team}/${key.session}`)} is not a team session`);
    }
    // A dot is in neither an id nor a Claude Code session id, so the two kinds of name never meet.
    return join(this.dir, `${key.team}.${key.session}.json`);
  }
}
