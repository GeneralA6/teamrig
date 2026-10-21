import type { Files } from '../core/files.ts';
import { isStringArray } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { Mutex } from '../core/lock.ts';
import type { UnownedWarning } from './unowned.ts';

/** The format of the file this code reads and writes; a file in another format reads as none told. */
export const UNOWNED_NOTICES_FORMAT = 1;

/** The keys of the warnings the lead was told of; undefined when the text is damaged or from another format. */
export function parseUnownedNotices(text: string): readonly string[] | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== UNOWNED_NOTICES_FORMAT) {
    return undefined;
  }
  const told = record['told'];
  return isStringArray(told) ? told : undefined;
}

export function formatUnownedNotices(told: readonly string[]): string {
  return toJsonlLine({ [VERSION_FIELD]: UNOWNED_NOTICES_FORMAT, told: [...told] });
}

/**
 * The warnings the lead is still to be told of, in order: one per key (two flags of one kind on one skill share it), none
 * already told, at most `max`.
 */
export function freshUnowned(standing: readonly UnownedWarning[], told: ReadonlySet<string>, max: number): UnownedWarning[] {
  const seen = new Set(told);
  const fresh: UnownedWarning[] = [];
  for (const warning of standing) {
    if (fresh.length < max && !seen.has(warning.key)) {
      seen.add(warning.key);
      fresh.push(warning);
    }
  }
  return fresh;
}

/** What stays told after a start: the told keys still standing, then those just posted. A cleared one drops out, so it is told again if it returns. */
export function toldAfter(told: ReadonlySet<string>, standing: readonly UnownedWarning[], posted: readonly UnownedWarning[]): string[] {
  const keys = new Set(standing.map((warning) => warning.key));
  return [...new Set([...[...told].filter((key) => keys.has(key)), ...posted.map((warning) => warning.key)])];
}

/** A warning whose inbox line was refused, with why. */
export interface UnownedFailure {
  readonly warning: UnownedWarning;
  readonly problem: string;
}

/** What one start told the lead. */
export interface UnownedTold {
  /** The warnings whose line reached the lead's inbox. */
  readonly posted: readonly UnownedWarning[];
  /** The warnings whose line was refused; they stay untold, so the next start tries again. */
  readonly failed: readonly UnownedFailure[];
}

/** Posts the lead's inbox line on one warning; a problem when the line was refused. */
export type PostUnowned = (warning: UnownedWarning) => Promise<string | undefined>;

const NONE_TOLD: UnownedTold = { posted: [], failed: [] };

/**
 * Which warnings no session owns the lead was told of, one small file per team (T951). Every session's `start` tells
 * the lead of the new ones, so the file is read and written under a lock: starts after a reboot run side by side, and
 * each warning is told once while it stands.
 */
export class UnownedNotices {
  private readonly files: Files;
  private readonly path: string;
  private readonly mutex: Mutex;

  constructor(files: Files, path: string, mutex: Mutex) {
    this.files = files;
    this.path = path;
    this.mutex = mutex;
  }

  /** The keys told so far; none for an absent or damaged file. */
  async told(): Promise<ReadonlySet<string>> {
    const text = await this.files.read(this.path);
    return new Set(text === undefined ? [] : (parseUnownedNotices(text) ?? []));
  }

  /**
   * Tells the lead of at most `max` standing warnings not told yet, through `post`, and forgets the cleared ones. The
   * lock is taken only when something changes, so a start with nothing new reads one small file.
   */
  async tell(standing: readonly UnownedWarning[], max: number, post: PostUnowned): Promise<UnownedTold> {
    if (this.settled(await this.told(), standing)) {
      return NONE_TOLD;
    }
    return this.mutex.run(async () => {
      const told = await this.told();
      const posted: UnownedWarning[] = [];
      const failed: UnownedFailure[] = [];
      for (const warning of freshUnowned(standing, told, max)) {
        const problem = await post(warning);
        if (problem === undefined) {
          posted.push(warning);
        } else {
          failed.push({ warning, problem });
        }
      }
      const next = toldAfter(told, standing, posted);
      if (next.length !== told.size || next.some((key) => !told.has(key))) {
        await this.files.write(this.path, formatUnownedNotices(next));
      }
      return { posted, failed };
    });
  }

  /** True when every standing warning was told and every told one still stands. */
  private settled(told: ReadonlySet<string>, standing: readonly UnownedWarning[]): boolean {
    const keys = new Set(standing.map((warning) => warning.key));
    return freshUnowned(standing, told, 1).length === 0 && [...told].every((key) => keys.has(key));
  }
}
