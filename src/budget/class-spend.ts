import type { FocusConfig } from '../config/types.ts';
import { formatUtcDay } from '../core/time.ts';
import type { Task } from '../register/fold.ts';
import { classOf } from '../register/focus.ts';
import type { UsageState } from './store.ts';
import { taskDaysOf } from './task-use.ts';
import { wSince } from './week.ts';

/**
 * Where the team's W went by work class (T2088), for `teamrig budget`: the W each session's turns put on a task, per
 * class, beside the share of the week `focus.allocation` plans for it. Pure: the caller reads the usage and the tasks.
 */

/** The row of the W no class took: turns that named no task, helpers, and task ids the register does not hold. */
export const NO_TASK_ROW = 'No task';

/** The W of a span by class, and what no class took; the two add up to everyone's W in the span (`wSince`). */
export interface ClassSpend {
  readonly byClass: ReadonlyMap<string, number>;
  readonly noTaskW: number;
}

/** One row of the spend by class: a class, or `NO_TASK_ROW`. */
export interface ClassRow {
  readonly name: string;
  readonly todayW: number;
  /** Undefined while the week's start is unknown. */
  readonly weekW: number | undefined;
  /** The class's share in `focus.allocation`; undefined for a class it does not list, and for `NO_TASK_ROW`. */
  readonly allocationPct: number | undefined;
}

export interface ClassRowsInput {
  /** The team's sessions' usage. */
  readonly states: readonly UsageState[];
  readonly tasks: Iterable<Pick<Task, 'id' | 'workClass'>>;
  readonly focus: Pick<FocusConfig, 'classes' | 'defaultClass' | 'allocation'>;
  /** Where today's use counts from (`WeekReading.todayFrom`). */
  readonly todayFrom: number;
  /** Where the week's use counts from; undefined while no reset is known. */
  readonly weekFrom: number | undefined;
  readonly now: number;
}

/**
 * The part of a session's W on `from`'s UTC day that falls from `from`'s hour on, as `wSince` counts it. `byTask` is
 * kept per day only, so a span that begins mid-day, as a week does at its reset, takes this part of each task's W there.
 */
function partAfter(state: UsageState, from: number): number {
  const dayW = state.byDay[formatUtcDay(new Date(from))]?.w ?? 0;
  return dayW > 0 ? wSince([state], from, from) / dayW : 0;
}

/** The W from the hour of `from` to `now` by the class `classOfTask` gives each task; a task it gives none counts as no task. */
export function classSpendSince(states: readonly UsageState[], from: number, now: number, classOfTask: (task: string) => string | undefined): ClassSpend {
  const fromDay = formatUtcDay(new Date(from));
  const today = formatUtcDay(new Date(now));
  const byClass = new Map<string, number>();
  for (const state of states) {
    const firstDayPart = partAfter(state, from);
    for (const [day, tasks] of taskDaysOf(state)) {
      if (day < fromDay || day > today) {
        continue;
      }
      const part = day === fromDay ? firstDayPart : 1;
      for (const [task, w] of tasks) {
        const name = classOfTask(task);
        if (name !== undefined) {
          byClass.set(name, (byClass.get(name) ?? 0) + w * part);
        }
      }
    }
  }
  const classedW = [...byClass.values()].reduce((total, w) => total + w, 0);
  return { byClass, noTaskW: Math.max(0, wSince(states, from, now) - classedW) };
}

/**
 * The spend by class today and this week: `focus.classes` in their order, then any class a task still holds that the
 * config no longer lists (a class is kept on a task when it leaves the list), then `NO_TASK_ROW`, so the rows add up
 * to the sessions' W.
 */
export function classRowsOf(input: ClassRowsInput): ClassRow[] {
  const { states, focus, todayFrom, weekFrom, now } = input;
  const classes = new Map<string, string>();
  for (const task of input.tasks) {
    classes.set(task.id, classOf(task, focus));
  }
  const spendSince = (from: number): ClassSpend => classSpendSince(states, from, now, (task) => classes.get(task));
  const today = spendSince(todayFrom);
  const week = weekFrom === undefined ? undefined : spendSince(weekFrom);
  const spent = new Set([...today.byClass.keys(), ...(week?.byClass.keys() ?? [])]);
  const unlisted = [...spent].filter((name) => !focus.classes.includes(name)).sort((a, b) => a.localeCompare(b));
  const rows = [...focus.classes, ...unlisted].map((name) => ({
    name,
    todayW: today.byClass.get(name) ?? 0,
    weekW: week === undefined ? undefined : (week.byClass.get(name) ?? 0),
    allocationPct: focus.allocation[name],
  }));
  return [...rows, { name: NO_TASK_ROW, todayW: today.noTaskW, weekW: week?.noTaskW, allocationPct: undefined }];
}
