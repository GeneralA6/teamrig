import { formatUtcDay, MS_PER_DAY } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { NO_GOAL, type Goal, type GoalSlip } from './goals.ts';
import { ACTIVE_STATUSES } from './model.ts';
import type { StatsTask } from './stats.ts';

/** How far back a goal's pace looks: two weeks, so one quiet weekend does not read as a stall. */
export const GOAL_PACE_DAYS = 14;

export const GOAL_STATES = ['done', 'on track', 'at risk', 'late'] as const;

export type GoalState = (typeof GOAL_STATES)[number];

/** A calendar day of the team's zone on which tasks of a goal were done. */
export interface GoalDay {
  readonly day: string;
  readonly done: number;
}

/** One goal over its whole history, whatever range the stats were asked for: a goal outlives any window. */
export interface GoalProgress {
  readonly tag: string;
  readonly title: string;
  readonly start: string;
  readonly target: string;
  readonly parent: string | null;
  readonly slips: readonly GoalSlip[];
  /** Its tasks done now; a dropped task counts for neither this nor {@link open}. */
  readonly done: number;
  readonly open: number;
  /** Only the days with a task done, oldest first: a burn-up sums them. */
  readonly doneDays: readonly GoalDay[];
  /** Tasks done per day over the last {@link GOAL_PACE_DAYS} days. */
  readonly pace: number;
  /** The day the open tasks end at that pace; null with no pace, or with none open. */
  readonly forecast: string | null;
  readonly state: GoalState;
  readonly tasks: readonly StatsTask[];
}

export interface GoalStats {
  /** In the order the goals were added. */
  readonly goals: readonly GoalProgress[];
  /** Of {@link doneInRange}, the tasks with no goal tag: a tag with no record still served a goal. */
  readonly offGoal: number;
  /** The tasks done in the stats range. */
  readonly doneInRange: number;
}

export interface GoalStatsInput {
  readonly goals: ReadonlyMap<string, Goal>;
  /** Every task in scope, whatever its status. */
  readonly tasks: readonly StatsTask[];
  readonly doneInRange: readonly StatsTask[];
  readonly now: Date;
  readonly zone: TimeZone;
  /** One session's numbers: only the goals with a task in scope list, else every other goal lists empty. */
  readonly scoped: boolean;
}

interface Today {
  readonly day: string;
  /** The day's UTC midnight, so days step by MS_PER_DAY whatever the clock change. */
  readonly ms: number;
  readonly zone: TimeZone;
}

export function goalStats(input: GoalStatsInput): GoalStats {
  const day = input.zone.day(input.now);
  const today: Today = { day, ms: Date.parse(day), zone: input.zone };
  const served = tasksByGoal(input.tasks, input.goals);
  const progress = [...input.goals.values()].map((goal) => goalProgress(goal, served.get(goal.tag) ?? [], today));
  return {
    goals: input.scoped ? progress.filter((goal) => goal.tasks.length > 0) : progress,
    offGoal: input.doneInRange.filter(({ task }) => task.goals.every((tag) => tag === NO_GOAL)).length,
    doneInRange: input.doneInRange.length,
  };
}

/** Each goal's tasks: a set of tags per task, so a task with two tags under one goal counts once for it. */
function tasksByGoal(tasks: readonly StatsTask[], goals: ReadonlyMap<string, Goal>): Map<string, StatsTask[]> {
  const byGoal = new Map<string, StatsTask[]>();
  for (const each of tasks) {
    for (const tag of new Set(each.task.goals.flatMap((taskTag) => goalsServed(taskTag, goals)))) {
      byGoal.set(tag, [...(byGoal.get(tag) ?? []), each]);
    }
  }
  return byGoal;
}

/** The goals a task's tag serves: its deepest record, then that record's parents; the seen set stops a parent cycle. */
function goalsServed(tag: string, goals: ReadonlyMap<string, Goal>): string[] {
  const seen = new Set<string>();
  let goal = deepestGoal(tag, goals);
  while (goal !== undefined && !seen.has(goal.tag)) {
    seen.add(goal.tag);
    goal = goal.parent === null ? undefined : goals.get(goal.parent);
  }
  return [...seen];
}

/** Tasks carry finer tags than the records (R1.3e under R1.3), so the longest record that covers the tag is its goal. */
function deepestGoal(tag: string, goals: ReadonlyMap<string, Goal>): Goal | undefined {
  return [...goals.values()].filter((goal) => covers(goal.tag, tag)).reduce<Goal | undefined>((best, goal) => (best === undefined || goal.tag.length > best.tag.length ? goal : best), undefined);
}

/** A digit after the prefix is another number, not a finer tag: R1.10 is no part of R1.1. */
function covers(goal: string, tag: string): boolean {
  return tag.startsWith(goal) && !/^\d/.test(tag.slice(goal.length));
}

function goalProgress(goal: Goal, tasks: readonly StatsTask[], today: Today): GoalProgress {
  const doneOn = tasks.filter(({ task }) => task.status === 'done').map(({ task }) => today.zone.day(new Date(task.statusAt)));
  const open = tasks.filter(({ task }) => ACTIVE_STATUSES.includes(task.status)).length;
  const paceFrom = dayFrom(today, 1 - GOAL_PACE_DAYS);
  const pace = doneOn.filter((day) => day >= paceFrom).length / GOAL_PACE_DAYS;
  const forecast = open > 0 && pace > 0 ? dayFrom(today, Math.ceil(open / pace)) : null;
  return {
    tag: goal.tag,
    title: goal.title,
    start: goal.start,
    target: goal.target,
    parent: goal.parent,
    slips: goal.slips,
    done: doneOn.length,
    open,
    doneDays: doneDays(doneOn),
    pace,
    forecast,
    state: stateOf(goal, doneOn.length, open, forecast, today.day),
    tasks,
  };
}

function stateOf(goal: Goal, done: number, open: number, forecast: string | null, today: string): GoalState {
  if (open === 0 && done > 0) return 'done';
  if (goal.target < today) return 'late';
  if (open === 0) return 'on track';
  if (forecast === null) return today < goal.start ? 'on track' : 'at risk';
  return forecast <= goal.target ? 'on track' : 'at risk';
}

function doneDays(days: readonly string[]): GoalDay[] {
  const counts = new Map<string, number>();
  for (const day of days) counts.set(day, (counts.get(day) ?? 0) + 1);
  return [...counts].map(([day, done]) => ({ day, done })).sort((a, b) => (a.day < b.day ? -1 : 1));
}

function dayFrom(today: Today, days: number): string {
  return formatUtcDay(new Date(today.ms + days * MS_PER_DAY));
}
