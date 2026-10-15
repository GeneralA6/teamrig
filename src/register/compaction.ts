import { toJsonlLine } from '../core/jsonl.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { currentWeekOf } from './check.ts';
import type { RegisterEvent } from './events.ts';
import { RegisterFold, taskNumber, type Task } from './fold.ts';
import { snapshotHeaderRecord, type SnapshotHeader } from './layout.ts';
import type { RegisterSnapshot } from './snapshot.ts';

/**
 * How long a finished task stays in the working set: a week plan, its review and a day more. The pane
 * shows tasks finished within a day, so it never needs a retired one.
 */
export const RETAIN_DAYS = 8;

export interface CompactionOptions {
  /** The last segment the new snapshot covers: `source` must be the fold of segments 1..covered. */
  readonly covered: number;
  readonly now: Date;
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

/**
 * The snapshot of a register's working set after a compaction: the header, then, in write order, every
 * event but those of the tasks it retires, so `show` lists the same events for every task it keeps. The
 * orphans among the events left out are counted in the header.
 * `source` must hold in `read.events` exactly the events its state folds from (a working-set or a
 * history read), and hold no line from a newer teamrig: the snapshot would drop it, so such a log is
 * never compacted (rotate.ts).
 */
export function compactRegister(source: RegisterSnapshot, options: CompactionOptions): Compaction {
  const now = options.now.getTime();
  const floor = currentWeekOf(source, options.now);
  const retainMs = options.retainDays * MS_PER_DAY;
  const retiring = [...source.state.tasks.values()].filter((task) => !options.keep.has(task.id) && isRetirable(task, now, retainMs, floor));
  const retiredIds = new Set(retiring.map((task) => task.id));
  const fold = new RegisterFold();
  const kept: RegisterEvent[] = [];
  let keptOrphans = 0;
  for (const event of source.read.events) {
    const applied = fold.apply(event);
    if (!retiredIds.has(event.id)) {
      kept.push(event);
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
    retired: (source.retired?.count ?? 0) + retiring.length,
    retiredLastWeek: newestWeek([source.retired?.lastWeek ?? null, ...retiring.map((task) => task.week)]),
    at: options.now.toISOString(),
  };
  const text = [snapshotHeaderRecord(header), ...kept.map((event) => ({ ...event }))].map(toJsonlLine).join('');
  const retiredNow = retiring.map((task) => task.id).sort((a, b) => taskNumber(a) - taskNumber(b));
  return { header, text, kept: source.state.tasks.size - retiring.length, retiredNow };
}
