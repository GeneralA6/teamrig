/**
 * The done groups (T1729, T1121): one rule that sorts a span's done work into the groups the
 * owner reads it in, so the daily report, the meeting agenda's DONE section and the pane's Done page never disagree.
 * A task done in the span goes in the first group it fits: Owner asked (its source is the owner marker), one group per
 * goal (its first goal), Urgent p1 (priority p0 or p1), This week's plan (its planning week holds the moment it was
 * done) and Other work. Dropped tasks are counted apart, never mixed in. Pure: no clock, no disk, no `node:` imports
 * (the pane vendors it through `read/index`). It reads only the fields of DoneGroupTask and hands back the caller's own
 * rows, so the pane groups its task rows, which lack most of Task's fields, without copying them into Tasks.
 */
import { addUtcDays, parseDayStart } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { taskNumber, type Task } from './fold.ts';
import { priorityText } from './model.ts';

/** The highest priority number the Urgent group takes: p0 and p1. */
export const URGENT_PRIORITY = 1;

/** The days a planning week spans from its `YYYY-MM-DD` start tag. */
const WEEK_DAYS = 7;

/** The groups in the order the rule tries them, and the order they print in. */
export const DONE_GROUP_KINDS = ['owner', 'goal', 'urgent', 'plan', 'other'] as const;
export type DoneGroupKind = (typeof DONE_GROUP_KINDS)[number];

/** The fields of a task the rule reads: a Task has them, and so does a reader's own task row. */
export type DoneGroupTask = Pick<Task, 'id' | 'status' | 'statusAt' | 'source' | 'goals' | 'priority' | 'week'>;

export interface DoneGroup<T extends DoneGroupTask = Task> {
  readonly kind: DoneGroupKind;
  /** The goal tag of a `goal` group; null for every other kind. */
  readonly goal: string | null;
  /** By priority, then by when it was done, then by id. */
  readonly tasks: readonly T[];
}

export interface DoneGroupsInput<T extends DoneGroupTask = Task> {
  readonly tasks: Iterable<T>;
  /** The register's marker for the owner (`register.ownerSource`): a task with this source is Owner asked. */
  readonly ownerMarker: string;
  /** The team's zone: a planning week starts at the start of its tag's day there. */
  readonly zone: TimeZone;
  /** The span, as epoch milliseconds: a task counts when it took its status at or after `from` and before `to`. */
  readonly from: number;
  readonly to: number;
}

export interface DoneGroups<T extends DoneGroupTask = Task> {
  /** Only the groups holding a task, in rule order; goal groups ordered by tag. */
  readonly groups: readonly DoneGroup<T>[];
  /** How many tasks the groups hold. */
  readonly done: number;
  /** The tasks dropped in the span, in the same order as a group's. */
  readonly dropped: readonly T[];
}

/** Sort `input.tasks` closed in the span into the done groups, with the dropped ones apart. */
export function doneGroups<T extends DoneGroupTask>(input: DoneGroupsInput<T>): DoneGroups<T> {
  const byKind = new Map<DoneGroupKind, T[]>();
  const byGoal = new Map<string, T[]>();
  const dropped: T[] = [];
  let done = 0;
  for (const task of input.tasks) {
    const at = Date.parse(task.statusAt);
    if (!(at >= input.from && at < input.to)) {
      continue;
    }
    if (task.status === 'dropped') {
      dropped.push(task);
      continue;
    }
    if (task.status !== 'done') {
      continue;
    }
    done += 1;
    const goal = task.goals[0];
    if (task.source !== input.ownerMarker && goal !== undefined) {
      pushTo(byGoal, goal, task);
    } else {
      pushTo(byKind, kindOf(task, at, input), task);
    }
  }
  const groups: DoneGroup<T>[] = [];
  for (const kind of DONE_GROUP_KINDS) {
    if (kind === 'goal') {
      const tags = [...byGoal.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      groups.push(...tags.map((tag) => ({ kind, goal: tag, tasks: inGroupOrder(byGoal.get(tag) ?? []) })));
      continue;
    }
    const tasks = byKind.get(kind);
    if (tasks !== undefined) {
      groups.push({ kind, goal: null, tasks: inGroupOrder(tasks) });
    }
  }
  return { groups, done, dropped: inGroupOrder(dropped) };
}

/** The heading a group prints under: `Owner asked`, its goal tag, `Urgent p1`, `This week's plan` or `Other work`. */
export function doneGroupTitle(group: Pick<DoneGroup<DoneGroupTask>, 'kind' | 'goal'>): string {
  switch (group.kind) {
    case 'owner':
      return 'Owner asked';
    case 'goal':
      return group.goal ?? 'Goal';
    case 'urgent':
      return `Urgent ${priorityText(URGENT_PRIORITY)}`;
    case 'plan':
      return "This week's plan";
    case 'other':
      return 'Other work';
  }
}

/** The group of a done task with no goal (or an owner-asked one): every kind but `goal`. */
function kindOf<T extends DoneGroupTask>(task: T, doneAt: number, input: DoneGroupsInput<T>): DoneGroupKind {
  if (task.source === input.ownerMarker) {
    return 'owner';
  }
  if (task.priority <= URGENT_PRIORITY) {
    return 'urgent';
  }
  return task.week !== null && inWeek(task.week, doneAt, input.zone) ? 'plan' : 'other';
}

/**
 * Whether `at` falls in the planning week tagged `week`: from the start of its day in the team's zone to the start of
 * the day seven days on, each found from its own date, so a week across a clock change still ends at midnight.
 */
function inWeek(week: string, at: number, zone: TimeZone): boolean {
  const start = parseDayStart(week, zone);
  const next = addUtcDays(week, WEEK_DAYS);
  const end = next === undefined ? undefined : parseDayStart(next, zone);
  return start !== undefined && end !== undefined && at >= start.getTime() && at < end.getTime();
}

function pushTo<K, T>(map: Map<K, T[]>, key: K, task: T): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [task]);
  } else {
    list.push(task);
  }
}

function inGroupOrder<T extends DoneGroupTask>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => a.priority - b.priority || Date.parse(a.statusAt) - Date.parse(b.statusAt) || taskNumber(a.id) - taskNumber(b.id));
}
