import { toJsonlLine } from '../core/jsonl.ts';
import { MS_PER_DAY } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { currentWeekOf } from './week.ts';
import { RegisterFold, taskNumber, type Task } from './fold.ts';
import { snapshotHeaderRecord, type SnapshotHeader } from './layout.ts';
import type { EventLogRead, RegisterSnapshot } from './snapshot.ts';

/**
 * How long a finished task stays in the working set: a week plan, its review and a day more. The pane
 * shows tasks finished within a day, so it never needs a retired one.
 */
export const RETAIN_DAYS = 8;

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
  /** Tasks in the new working set. */
  readonly kept: number;
  /** The ids this compaction retires, in id order. */
  readonly retiredNow: readonly string[];
}

/**
 * A task leaves the working set when every reader that skips the history can do without it: finished
 * (done or dropped) at least `retainMs` ago, and in no week plan from the one in force (`floor`) on. Then
 * `list` of active tasks, `check`, the current week's `plan` and the pane read the same on the working set
 * as on the whole history; `show`, `list --status done` and older plans read the history.
 */
export function isRetirable(task: Task, now: number, retainMs: number, floor: string | null): boolean {
  const finished = task.status === 'done' || task.status === 'dropped';
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
 * The snapshot of a register's working set after a compaction: the header, then, in write order, every
 * event but those of the tasks it retires, so `show` lists the same events for every task it keeps. Each
 * is its line as written, never re-serialized, so a field this code does not parse is kept. The orphans
 * among the events left out are counted in the header. A task that moved to another team retires at once, whatever
 * its age, with its moved line: the other team's register holds it, and the history still says where it went.
 * `source` must hold in `read.events` exactly the events its state folds from (a working-set or a
 * history read), and hold no line from a newer teamrig's format or status: those are no events, so the
 * snapshot would drop them, and such a log is never compacted (rotate.ts).
 */
export function compactRegister(source: RegisterSnapshot, options: CompactionOptions): Compaction {
  const now = options.now.getTime();
  const floor = currentWeekOf(source, options.now, options.zone);
  const retainMs = options.retainDays * MS_PER_DAY;
  const retiring = [...source.state.tasks.values()].filter((task) => !options.keep.has(task.id) && isRetirable(task, now, retainMs, floor));
  const moved = [...source.state.moved.keys()];
  const retiredIds = new Set([...retiring.map((task) => task.id), ...moved]);
  const fold = new RegisterFold();
  const kept: string[] = [];
  let keptOrphans = 0;
  for (const [index, event] of source.read.events.entries()) {
    const applied = fold.apply(event);
    if (!retiredIds.has(event.id)) {
      kept.push(lineOf(source.read, index));
      keptOrphans += applied ? 0 : 1;
    }
  }
  const header: SnapshotHeader = {
    covered: options.covered,
    events: kept.length,
    nextId: source.state.nextId,
    orphans: source.state.orphans - keptOrphans,
    unreadable: source.read.unreadable,
    newer: source.read.newer,
    newestVersion: source.read.newestVersion,
    retired: (source.retired?.count ?? 0) + retiredIds.size,
    retiredLastWeek: newestWeek([source.retired?.lastWeek ?? null, ...retiring.map((task) => task.week)]),
    at: options.now.toISOString(),
  };
  const text = [toJsonlLine(snapshotHeaderRecord(header)), ...kept.map((line) => `${line}\n`)].join('');
  const retiredNow = [...retiredIds].sort((a, b) => taskNumber(a) - taskNumber(b));
  return { header, text, kept: source.state.tasks.size - retiring.length, retiredNow };
}
