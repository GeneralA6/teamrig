import { toJsonlLine } from '../core/jsonl.ts';
import { MS_PER_DAY } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { currentWeekOf } from './week.ts';
import { cutTask } from './description-cut.ts';
import { RegisterFold, taskNumber, type Task } from './fold.ts';
import { snapshotHeaderRecord, type SnapshotHeader } from './layout.ts';
import { TASK_LINES_LAYOUT_VERSION } from './marker.ts';
import type { EventLogRead, RegisterSnapshot } from './snapshot.ts';
import { taskLineRecord } from './task-line.ts';

/**
 * How long a finished task stays in the working set: a week plan, its review and a day more. The pane
 * shows tasks finished within a day, so it never needs a retired one.
 */
export const RETAIN_DAYS = 8;

/**
 * How far back a snapshot keeps events as written (T4076); before that it holds each task's folded state. A
 * meeting lasts under a day and a leader's digest cursor is hours old, so their reads stay on the working set;
 * `show` of an older task, and any read from further back, reads the history.
 */
export const EVENT_WINDOW_DAYS = 2;

export interface CompactionOptions {
  /** The last segment the new snapshot covers: `source` must be the fold of segments 1..covered. */
  readonly covered: number;
  readonly now: Date;
  /** The team's zone, which a week tag is a day of. */
  readonly zone: TimeZone;
  readonly retainDays: number;
  /** Ids kept in the working set whatever their age: a task a write is about to change. */
  readonly keep: ReadonlySet<string>;
}

export interface Compaction {
  readonly header: SnapshotHeader;
  /** The new `snapshot.jsonl`. */
  readonly text: string;
  /** Its event lines, each as written: those of the window. */
  readonly eventLines: readonly string[];
  /** Tasks in the new working set. */
  readonly kept: number;
  /** The ids this compaction retires, in id order. */
  readonly retiredNow: readonly string[];
}

/**
 * A task leaves the working set when every reader that skips the history can do without it: finished
 * (done or dropped) at least `retainMs` ago, and in no week plan from the one in force (`floor`) on. Then
 * `list` of active tasks, `check`, the current week's `plan` and the pane read the same on the working set
 * as on the whole history; `show`, `list --status done` and older plans read the history. A done task still
 * watched for a sighting stays too: `verify` lists it from the working set.
 */
export function isRetirable(task: Task, now: number, retainMs: number, floor: string | null): boolean {
  const finished = (task.status === 'done' && task.watch === null) || task.status === 'dropped';
  const inPlan = task.week !== null && (floor === null || task.week >= floor);
  return finished && !inPlan && now - Date.parse(task.updatedAt) >= retainMs;
}

function newestWeek(weeks: readonly (string | null)[]): string | null {
  return weeks.reduce<string | null>((best, week) => (week !== null && (best === null || week > best) ? week : best), null);
}

/** The line event `index` of `read` was read from: a read holds one for each event. */
function lineOf(read: EventLogRead, index: number): string {
  const line = read.lines[index];
  if (line === undefined) {
    throw new Error(`event ${index + 1} of ${read.events.length} has no line: the read holds ${read.lines.length}`);
  }
  return line;
}

/**
 * Where the new snapshot's events start: EVENT_WINDOW_DAYS before the compaction, and never before the events
 * `source` holds, since the task lines must stand at a time its events reach back to.
 */
function windowStart(source: RegisterSnapshot, now: number): string {
  const start = new Date(now - EVENT_WINDOW_DAYS * MS_PER_DAY).toISOString();
  const held = source.window?.from;
  return held !== undefined && Date.parse(held) > Date.parse(start) ? held : start;
}

/** The fold `source.read.events` goes on from: its window's tasks, or nothing when it holds every event. */
function foldStart(source: RegisterSnapshot): RegisterFold {
  return source.window === null ? new RegisterFold() : new RegisterFold({ tasks: source.window.tasks, orphans: 0, nextId: 'T1', moved: new Map() });
}

/**
 * The snapshot of a register's working set after a compaction (layout.ts): the header, then a task line for
 * each task it keeps as that task stood at `windowFrom`, then, in write order, every event written from then on
 * (the first event at or after `windowFrom` and every one after it) but those of the tasks it retires. Each such
 * event is its line as written, never re-serialized, so a field this code does not parse is kept; a task line
 * holds the task as this code folds it, so such a field of an older event is left to the archive, which keeps
 * every line, and `teamrig compact --from-history` folds again from it. A task line leaves the task's description
 * out and holds its mark (description-cut.ts, T4781): a description is most of a task's bytes, an imported issue's
 * body above all, and the history keeps it for the readers that print it, while an event of the window that gives
 * one keeps it as written, so a task holds its text whole until that event leaves the window. The orphans among the
 * events left out are counted in the header. A task that moved to another team retires at once, whatever its age,
 * with its moved line: the other team's register holds it, and the history still says where it went.
 * `source` must hold in `read.events` exactly the events its state folds from on top of its window (a
 * working-set or a history read), and hold no line from a newer teamrig's format or status: those are no events,
 * so the snapshot would drop them, and such a log is never compacted (rotate.ts).
 */
export function compactRegister(source: RegisterSnapshot, options: CompactionOptions): Compaction {
  const now = options.now.getTime();
  const floor = currentWeekOf(source, options.now, options.zone);
  const retainMs = options.retainDays * MS_PER_DAY;
  const retiring = [...source.state.tasks.values()].filter((task) => !options.keep.has(task.id) && isRetirable(task, now, retainMs, floor));
  const moved = [...source.state.moved.keys()];
  const retiredIds = new Set([...retiring.map((task) => task.id), ...moved]);
  const windowFrom = windowStart(source, now);
  const cut = Date.parse(windowFrom);
  const fold = foldStart(source);
  let atCut: ReadonlyMap<string, Task> | undefined;
  const eventLines: string[] = [];
  let keptOrphans = 0;
  for (const [index, event] of source.read.events.entries()) {
    atCut ??= Date.parse(event.at) >= cut ? fold.state().tasks : undefined;
    const applied = fold.apply(event);
    if (atCut !== undefined && !retiredIds.has(event.id)) {
      eventLines.push(lineOf(source.read, index));
      keptOrphans += applied ? 0 : 1;
    }
  }
  const lined = [...(atCut ?? fold.state().tasks).values()].filter((task) => !retiredIds.has(task.id)).sort((a, b) => taskNumber(a.id) - taskNumber(b.id));
  const header: SnapshotHeader = {
    covered: options.covered,
    events: eventLines.length,
    tasks: lined.length,
    windowFrom,
    nextId: source.state.nextId,
    orphans: source.state.orphans - keptOrphans,
    unreadable: source.read.unreadable,
    newer: source.read.newer,
    newestVersion: source.read.newestVersion,
    retired: (source.retired?.count ?? 0) + retiredIds.size,
    retiredLastWeek: newestWeek([source.retired?.lastWeek ?? null, ...retiring.map((task) => task.week)]),
    at: options.now.toISOString(),
  };
  const taskLines = lined.map((task) => toJsonlLine(taskLineRecord(TASK_LINES_LAYOUT_VERSION, cutTask(task))));
  const text = [toJsonlLine(snapshotHeaderRecord(header)), ...taskLines, ...eventLines.map((line) => `${line}\n`)].join('');
  const retiredNow = [...retiredIds].sort((a, b) => taskNumber(a) - taskNumber(b));
  return { header, text, eventLines, kept: source.state.tasks.size - retiring.length, retiredNow };
}
