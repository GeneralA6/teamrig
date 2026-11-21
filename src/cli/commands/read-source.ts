import { basename, isAbsolute, relative, sep } from 'node:path';
import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import type { TeamPaths } from '../../core/home.ts';
import type { RevisionParts, SessionPlace } from '../../interface/index.ts';
import type { Task } from '../../register/fold.ts';
import type { RegisterEvent } from '../../register/events.ts';
import { MissingSegmentError, readHistory, readWorkingSet, type LayoutPaths } from '../../register/layout.ts';
import { lacksEventsOf, type RegisterSnapshot } from '../../register/snapshot.ts';
import type { Kit, LoadedConfig } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import type { KitTree } from '../tree.ts';

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
  /** The host's conversation the run was asked from (`--conversation`); null when it names none. */
  readonly conversation: string | null;
  /** The session that conversation runs in, among the tree's teams; null with no conversation, or one no session holds. */
  readonly self: SessionPlace | null;
  /** Every team of the kit home, read once for the whole run by whichever part asks first. */
  readonly tree: () => Promise<KitTree>;
  readonly sinceHours: number;
  /** The task whose history is served (`--task`); null when the run names none, which only `history` minds. */
  readonly task: string | null;
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

/** `load`, run at the first call and answered from that one run after it. */
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => (loaded ??= load());
}

/** Each path's stamp, in order; null for a file that is not there. */
export async function stampsOf(runtime: CliRuntime, paths: readonly string[]): Promise<(string | null)[]> {
  const stamps: (string | null)[] = [];
  for (const path of paths) {
    stamps.push((await runtime.files.stamp(path)) ?? null);
  }
  return stamps;
}

/** The team a problem's file is named under, and the folder its name is counted from. */
export type ServedFolder = Pick<TeamPaths, 'team' | 'home'>;

/**
 * How a problem names a file: from the team's folder down, as `app/state/events.jsonl`, with `/` on every OS. Its
 * place on the disk is never served: it holds the user's home. A file the config moved out of the team's folder
 * (`paths`) is named by its own name alone, which is teamrig's.
 */
export function servedPathOf(folder: ServedFolder, path: string): string {
  return [folder.team, ...(belowOf(folder, path) ?? ['(moved)', basename(path)])].join('/');
}

/** The folders and the file that lead from the team's folder down to `path`; undefined for a path not inside it. */
export function belowOf(folder: ServedFolder, path: string): string[] | undefined {
  const below = relative(folder.home, path);
  const inside = below !== '' && !below.startsWith('..') && !isAbsolute(below);
  return inside ? below.split(sep) : undefined;
}

/**
 * The lines of a log that were left out of its read, a line per kind. Every problem a document carries is such a
 * fixed text: a file's served name, a count and a kind, never a parser's own message, which quotes the damaged
 * line, and that line was never scanned for a secret.
 */
export function skippedOf(folder: ServedFolder, path: string, read: { readonly unreadable: number; readonly newer: number }): string[] {
  const name = servedPathOf(folder, path);
  return [
    ...(read.unreadable > 0 ? [`${name}: ${read.unreadable} unreadable line(s) left out`] : []),
    ...(read.newer > 0 ? [`${name}: ${read.newer} line(s) from a newer teamrig left out; update teamrig`] : []),
  ];
}

/** A register's working set as a document reads it: the tasks by id, and what could not be read of them. */
export interface WorkingSet {
  readonly tasks: ReadonlyMap<string, Task>;
  readonly problems: readonly string[];
}

/**
 * The register's tasks and what could not be read of them. An archive with a segment gone serves no task and says
 * why, where a text command refuses: one broken document must not take down the others asked in the same run.
 */
export async function workingSetOf(runtime: CliRuntime, folder: ServedFolder, layout: LayoutPaths): Promise<WorkingSet> {
  try {
    const snapshot = await readWorkingSet(runtime.files, layout);
    return { tasks: snapshot.state.tasks, problems: damageOf(snapshot, folder, layout.tail) };
  } catch (error) {
    if (error instanceof MissingSegmentError) {
      const segment = servedPathOf(folder, error.path);
      return { tasks: new Map(), problems: [`${segment}: missing, so the register's archive is incomplete and its tasks cannot be read`] };
    }
    throw error;
  }
}

/** One task's events as a document reads them, and what could not be read of the register. */
export interface TaskEvents {
  readonly events: readonly RegisterEvent[];
  readonly problems: readonly string[];
}

/**
 * Every event the register holds of task `id`, in the order they were written, as `show` reads them: from the
 * working set where it holds them all, else from the whole history, whose cost grows with the archive. An archive
 * with a segment gone serves no event and says why, as {@link workingSetOf} does: half a history would read as a
 * whole one.
 */
export async function taskEventsOf(runtime: CliRuntime, folder: ServedFolder, layout: LayoutPaths, id: string): Promise<TaskEvents> {
  try {
    const recent = await readWorkingSet(runtime.files, layout);
    const snapshot = lacksEventsOf(recent, id) ? await readHistory(runtime.files, layout) : recent;
    return { events: snapshot.read.events.filter((event) => event.id === id), problems: damageOf(snapshot, folder, layout.tail) };
  } catch (error) {
    if (error instanceof MissingSegmentError) {
      const segment = servedPathOf(folder, error.path);
      return { events: [], problems: [`${segment}: missing, so the register's archive is incomplete and the task's history cannot be read`] };
    }
    throw error;
  }
}

/** Damaged or newer lines never stop a read; each kind left out is one line, so a reader shows which it is. */
function damageOf(snapshot: RegisterSnapshot, folder: ServedFolder, path: string): string[] {
  const { orphans } = snapshot.state;
  const unowned = orphans > 0 ? [`${servedPathOf(folder, path)}: ${orphans} event(s) naming no task left out`] : [];
  return [...skippedOf(folder, path, snapshot.read), ...unowned];
}

/**
 * What the config's own read has to tell, as `configWarnings` tells a person, less the first problem's words: they
 * quote the value found, which no shape was looked for in. `teamrig config validate` prints them to the person.
 */
export function configProblemsOf(folder: ServedFolder, load: LoadedConfig): string[] {
  const name = servedPathOf(folder, load.path);
  const { newerVersion, issues } = load;
  return [
    ...(newerVersion === undefined ? [] : [`${name}: config version ${newerVersion}, from a newer teamrig, read best-effort; update teamrig`]),
    ...(issues.length === 0 ? [] : [`${name}: ${issues.length} problem(s), defaults used; run: teamrig config validate`]),
  ];
}
