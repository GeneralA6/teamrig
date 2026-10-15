import { isDeepStrictEqual } from 'node:util';
import type { Files } from '../core/files.ts';
import { toJsonlLine } from '../core/jsonl.ts';
import { compactRegister, type Compaction } from './compaction.ts';
import { assemble, historyPlan, readPlan, readSnapshotText, workingSetPlan, type LayoutPaths } from './layout.ts';
import { markerRecord } from './marker.ts';
import { isWritable, readEvents, type EventLogRead, type RegisterSnapshot } from './snapshot.ts';

/**
 * Rotation, the register's one rewrite: the tail becomes the next archive segment, a new tail starts with
 * a marker naming it, and a new snapshot holds the working set as of that segment (compaction.ts). It runs
 * under the register's lock, as every write does, so no append lands between its reads and its writes.
 * Each step leaves files every reader folds to the same tasks, so a rotation stopped anywhere loses nothing
 * and needs no repair by hand:
 * 1. the segment is created whole (written aside, then linked into place). No reader looks at it until the
 *    tail names it, and a later rotation replaces it while it is still the start of the tail;
 * 2. the tail is replaced atomically by the marker: readers fold the old snapshot and the new segment;
 * 3. the snapshot is replaced atomically.
 * A segment a tail has named is never written again, and no file is ever deleted.
 */

/** The files a rotation reads and writes. */
export type RotationFiles = Pick<Files, 'read' | 'write' | 'createExclusive'>;

/**
 * A tail this long makes a write rotate a register rotated before (about 1,500 events, a few days of a busy
 * team), so a read costs at most about this much beyond the working set, unless the team set
 * `register.autoArchive` to false. The first rotation is always a person's, with `teamrig compact`: every
 * session must run a teamrig that reads the rotated layout first.
 */
export const AUTO_ROTATE_CHARS = 512 * 1024;

export interface RotationOptions {
  readonly now: Date;
  readonly retainDays: number;
  /** Ids kept in the working set whatever their age (compaction.ts). */
  readonly keep: ReadonlySet<string>;
  /**
   * Also fold the whole history and hold the working set the snapshot comes from against it, as
   * `teamrig compact` does; a write's rotation skips it, so its cost stays with the recent events.
   */
  readonly checkHistory: boolean;
}

/** The whole history, folded to check the working set a rotation starts from. */
export interface HistoryCheck {
  readonly tasks: number;
  readonly events: number;
}

/** What a rotation will write, and the checks it passed or failed; it writes nothing itself. */
export interface RotationPlan {
  /** The archive segment the tail becomes. */
  readonly segment: number;
  /** The tail as read, which the segment holds byte for byte. */
  readonly tailText: string;
  readonly tailEvents: number;
  /** What the new snapshot folds from: the current snapshot and the segments after it, or every segment. */
  readonly source: 'working set' | 'history';
  /** Why the current snapshot was not used, when there is one. */
  readonly skippedSnapshot: string | null;
  /** The events the source folded. */
  readonly sourceEvents: number;
  readonly compaction: Compaction;
  /** The new tail: the marker naming the segment. */
  readonly markerText: string;
  /** Tasks the new files fold to exactly as the source holds them. */
  readonly unchanged: number;
  /** A segment file a rotation stopped before the tail step left behind, holding the tail's start: replaced. */
  readonly leftover: boolean;
  readonly history: HistoryCheck | null;
  /** Nothing new to archive and no task to retire: a rotation would only add an empty segment. */
  readonly idle: boolean;
  /** Each is a reason the rotation must not be written; empty when it may. */
  readonly problems: readonly string[];
}

/** A rotation refused for the problems its plan found; nothing was written. */
export class RotationRefusedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the rotation is refused, nothing was written: ${problems.join('; ')}`);
    this.name = 'RotationRefusedError';
    this.problems = problems;
  }
}

function taskIds(snapshot: RegisterSnapshot): Set<string> {
  return new Set(snapshot.state.tasks.keys());
}

/** The counts a reader warns about or plans from, which a working set must carry as the history has them. */
function countsOf(snapshot: RegisterSnapshot): Record<string, string | number> {
  const { state, read } = snapshot;
  return { nextId: state.nextId, orphans: state.orphans, unreadable: read.unreadable, newer: read.newer, newestVersion: read.newestVersion };
}

function countProblems(what: string, actual: RegisterSnapshot, expected: RegisterSnapshot): string[] {
  const want = countsOf(expected);
  return Object.entries(countsOf(actual))
    .filter(([key, value]) => want[key] !== value)
    .map(([key, value]) => `${what} has ${key} ${String(value)} where ${String(want[key])} is expected`);
}

/**
 * The new files read back as a reader reads them (the snapshot, then the marker alone as the tail), held
 * against the source on every task and count: any difference is a problem that refuses the rotation.
 */
export function readBack(source: RegisterSnapshot, compaction: Compaction, markerText: string): { unchanged: number; problems: string[] } {
  const snapshot = readSnapshotText(compaction.text);
  if (snapshot.kind !== 'usable') {
    return { unchanged: 0, problems: [`the new snapshot does not read back: ${snapshot.kind === 'unusable' ? snapshot.reason : 'it is not there'}`] };
  }
  const tail = readEvents(markerText);
  const plan = workingSetPlan(snapshot, tail);
  const rebuilt = assemble(plan, [], tail);
  const retired = new Set(compaction.retiredNow);
  const problems = countProblems('the new working set', rebuilt, source);
  let unchanged = 0;
  for (const [id, task] of source.state.tasks) {
    const after = rebuilt.state.tasks.get(id);
    if (retired.has(id)) {
      if (after !== undefined) problems.push(`${id} is retired and still in the new working set`);
    } else if (isDeepStrictEqual(after, task)) {
      unchanged += 1;
    } else {
      problems.push(`${id} folds otherwise from the new files`);
    }
  }
  const extra = [...taskIds(rebuilt)].filter((id) => !source.state.tasks.has(id));
  problems.push(...extra.map((id) => `${id} is in the new working set and not in the old`));
  return { unchanged, problems };
}

/** The working set held against the whole history: equal on every task it keeps; the rest finished and counted as retired. */
function historyProblems(working: RegisterSnapshot, history: RegisterSnapshot): string[] {
  const problems = countProblems('the working set', working, history);
  for (const [id, task] of history.state.tasks) {
    const kept = working.state.tasks.get(id);
    if (kept === undefined) {
      if (task.status !== 'done' && task.status !== 'dropped') problems.push(`${id} is ${task.status} in the history and missing from the working set`);
    } else if (!isDeepStrictEqual(kept, task)) {
      problems.push(`${id} folds otherwise in the working set than in the history`);
    }
  }
  const missing = history.state.tasks.size - working.state.tasks.size;
  if (missing !== (working.retired?.count ?? 0)) {
    problems.push(`the working set counts ${working.retired?.count ?? 0} retired task(s) where the history has ${missing} outside it`);
  }
  return problems;
}

/** The segment file the tail would become, when one is there already: a leftover, or a problem. */
async function segmentProblem(files: RotationFiles, path: string, tailText: string): Promise<{ leftover: boolean; problem: string | null }> {
  const existing = await files.read(path);
  if (existing === undefined) {
    return { leftover: false, problem: null };
  }
  if (tailText.startsWith(existing)) {
    return { leftover: true, problem: null };
  }
  return { leftover: true, problem: `${path} is there and is not the start of the tail: move it aside by hand, then rotate again` };
}

/**
 * Reads the register and plans its rotation, writing nothing: a dry run is this plan alone. `tailText`,
 * when given, is the tail as the caller just read it under the lock, so it is not read twice.
 */
export async function planRotation(files: RotationFiles, paths: LayoutPaths, options: RotationOptions, tailText?: string): Promise<RotationPlan> {
  const snapshotRead = readSnapshotText(await files.read(paths.snapshot));
  const text = tailText ?? (await files.read(paths.tail)) ?? '';
  const tail: EventLogRead = readEvents(text);
  const working = workingSetPlan(snapshotRead, tail);
  const readPlanUsed = working.skipped === undefined ? working : historyPlan(tail);
  const source = await readPlan(files, paths, readPlanUsed, tail);
  const segment = tail.rotatedAfter + 1;
  const compaction = compactRegister(source, { covered: segment, now: options.now, retainDays: options.retainDays, keep: options.keep });
  const markerText = toJsonlLine(markerRecord(segment, options.now.toISOString()));
  const back = readBack(source, compaction, markerText);
  const existing = await segmentProblem(files, paths.segment(segment), text);
  const fromHistory = readPlanUsed.base === undefined;
  const history = options.checkHistory && !fromHistory ? await readPlan(files, paths, historyPlan(tail), tail) : null;
  const problems = [
    ...(isWritable(source.read) ? [] : [`the register has lines from a newer teamrig (v${source.read.newestVersion}): update teamrig before rotating it`]),
    ...(existing.problem === null ? [] : [existing.problem]),
    ...back.problems,
    ...(history === null ? [] : historyProblems(source, history)),
  ];
  const checked = history ?? (options.checkHistory ? source : null);
  return {
    segment,
    tailText: text,
    tailEvents: tail.events.length,
    source: fromHistory ? 'history' : 'working set',
    skippedSnapshot: working.skipped?.reason ?? null,
    sourceEvents: source.read.events.length,
    compaction,
    markerText,
    unchanged: back.unchanged,
    leftover: existing.leftover,
    history: checked === null ? null : { tasks: checked.state.tasks.size, events: checked.read.events.length },
    idle: tail.events.length === 0 && compaction.retiredNow.length === 0 && (!fromHistory || source.read.events.length === 0),
    problems,
  };
}

/** Writes a plan's rotation in the order that keeps every step readable; refused, with nothing written, when the plan found problems. */
export async function applyRotation(files: RotationFiles, paths: LayoutPaths, plan: RotationPlan): Promise<void> {
  if (plan.problems.length > 0) {
    throw new RotationRefusedError(plan.problems);
  }
  const segment = paths.segment(plan.segment);
  if (plan.leftover) {
    await files.write(segment, plan.tailText);
  } else if (!(await files.createExclusive(segment, plan.tailText))) {
    throw new RotationRefusedError([`${segment} appeared while the rotation ran: another writer is not taking the register's lock`]);
  }
  await files.write(paths.tail, plan.markerText);
  await files.write(paths.snapshot, plan.compaction.text);
}
