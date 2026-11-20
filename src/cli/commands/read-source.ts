import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import type { RevisionParts } from '../../interface/index.ts';
import type { Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';

/** What every document of one run of `teamrig read` is read from. */
export interface ReadScope {
  readonly runtime: CliRuntime;
  /** The caller's own team; `kit` is another's when `--team` names one above it. */
  readonly own: string;
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly roster: Roster;
  /** The one session whose tasks are served, by id; null serves every session's. */
  readonly owner: string | null;
  /**
   * The session asking, as typed (an id or a name); null when the run names none. The document that needs it reads
   * it against the roster, so a stale session variable never refuses a document that does not.
   */
  readonly asker: string | null;
  readonly sinceHours: number;
  /** What the config's own read has to tell: every document is read through it, so each carries these. */
  readonly warnings: readonly string[];
}

/** A document's own fields, and what could only partly be served. */
export interface Built {
  readonly body: object;
  readonly problems: readonly string[];
}

/**
 * One document: what its revision is made of, and its answer. `parts` reads file stamps only and is asked first,
 * so a write landing while `build` reads leaves the answer newer than its revision, never older: the reader's next
 * comparison then sees a change and reads again.
 */
export interface DocumentSource {
  parts(): Promise<RevisionParts>;
  build(): Promise<Built>;
}

/** Each path's stamp, in order; null for a file that is not there. */
export async function stampsOf(runtime: CliRuntime, paths: readonly string[]): Promise<(string | null)[]> {
  const stamps: (string | null)[] = [];
  for (const path of paths) {
    stamps.push((await runtime.files.stamp(path)) ?? null);
  }
  return stamps;
}

/** The lines of a log that were left out of its read, a line per kind. */
export function skippedOf(path: string, read: { readonly unreadable: number; readonly newer: number }): string[] {
  return [
    ...(read.unreadable > 0 ? [`${path}: ${read.unreadable} unreadable line(s) left out`] : []),
    ...(read.newer > 0 ? [`${path}: ${read.newer} line(s) from a newer teamrig left out; update teamrig`] : []),
  ];
}
