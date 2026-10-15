import { formatUtcMinute, parseUtcDeadline, shortUtc } from '../core/time.ts';
import type { RegisterEvent } from './events.ts';
import { taskNumber, type Task } from './fold.ts';
import { ACTIVE_STATUSES, priorityText, type TaskStatus } from './model.ts';

export interface ListFilter {
  readonly owner?: string;
  /** Default: the active statuses. */
  readonly statuses?: readonly TaskStatus[];
  readonly source?: string;
  readonly priorities?: readonly number[];
  /** Due strictly before this instant; undated tasks never match. */
  readonly dueBefore?: Date;
  /** A week plan's start day; null selects tasks in no week plan. */
  readonly week?: string | null;
  readonly goal?: string;
}

/** The fields plan order reads, so a reader can sort its own rows that carry them. */
export type PlanOrdered = Pick<Task, 'id' | 'priority' | 'due'>;

/** The task's deadline in ms, or undefined when it has none. */
export function dueTime(task: Pick<Task, 'due'>): number | undefined {
  return task.due === null ? undefined : parseUtcDeadline(task.due)?.getTime();
}

/** Plan order: priority, then due date (undated last), then id. */
export function byPlanOrder(a: PlanOrdered, b: PlanOrdered): number {
  const dueA = dueTime(a) ?? Number.POSITIVE_INFINITY;
  const dueB = dueTime(b) ?? Number.POSITIVE_INFINITY;
  return a.priority - b.priority || (dueA === dueB ? 0 : dueA < dueB ? -1 : 1) || taskNumber(a.id) - taskNumber(b.id);
}

export function selectTasks(tasks: Iterable<Task>, filter: ListFilter): Task[] {
  const statuses = filter.statuses ?? ACTIVE_STATUSES;
  const dueBefore = filter.dueBefore?.getTime();
  return [...tasks]
    .filter((task) => {
      const due = dueTime(task);
      return (
        statuses.includes(task.status) &&
        (filter.owner === undefined || task.owner === filter.owner) &&
        (filter.source === undefined || task.source === filter.source) &&
        (filter.priorities === undefined || filter.priorities.includes(task.priority)) &&
        (dueBefore === undefined || (due !== undefined && due < dueBefore)) &&
        (filter.week === undefined || task.week === filter.week) &&
        (filter.goal === undefined || task.goals.includes(filter.goal))
      );
    })
    .sort(byPlanOrder);
}

/** The task's id, or `<team>/<id>` when a roll-up over a tree of teams names its team. */
export function taskLabel(task: Task, team?: string): string {
  return team === undefined ? task.id : `${team}/${task.id}`;
}

/** The fields every task row starts with: `T12 in-progress`, `p2`, `owner alpha` and `due 01-15` when it has one. */
function rowHead(task: Task, team: string | undefined): string[] {
  const parts = [`${taskLabel(task, team)} ${task.status}`, priorityText(task.priority), `owner ${task.owner}`];
  if (task.due !== null) {
    parts.push(`due ${shortUtc(task.due)}`);
  }
  return parts;
}

/** `text` cut to `max` characters, counted in code points so a character is never split, ending in `…` when cut. */
export function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * The short row of `list` and `check`: `T12 in-progress, p2, owner alpha, due 01-15 | <title cut to titleChars>`.
 * It keeps what orders and assigns the work and leaves the week, source, goals and blocked note to `show`.
 */
export function formatShortTask(task: Task, titleChars: number, team?: string): string {
  return `${rowHead(task, team).join(', ')} | ${cut(task.title, titleChars)}`;
}

/**
 * One line that names each field, so a newcomer can read it:
 * `T12 in-progress, p2, owner alpha, due 01-15, week 01-13, from lead, goals G1 | title`.
 * With `team`, the id reads `<team>/T12`.
 */
export function formatTask(task: Task, team?: string): string {
  const parts = rowHead(task, team);
  if (task.week !== null) {
    parts.push(`week ${shortUtc(task.week)}`);
  }
  parts.push(`from ${task.source}`);
  if (task.goals.length > 0) {
    parts.push(`goals ${task.goals.join(',')}`);
  }
  const blocked = task.status === 'blocked' && task.note !== null ? ` (blocked: ${task.note})` : '';
  return `${parts.join(', ')} | ${task.title}${blocked}`;
}

/** One field of an update, as `show` prints it: a priority reads `p2`, a list joins with commas. */
function changeText(name: string, value: unknown): string {
  if (name === 'priority' && typeof value === 'number') {
    return priorityText(value);
  }
  return Array.isArray(value) ? value.join(',') : String(value);
}

/** One line per event, for `show`. */
export function formatEvent(event: RegisterEvent): string {
  const head = `${formatUtcMinute(new Date(event.at))} ${event.by} ${event.type}`;
  const note = 'note' in event && event.note !== null ? ` note="${event.note}"` : '';
  switch (event.type) {
    case 'create': {
      const { task } = event;
      return [
        head,
        `owner=${task.owner}`,
        `source=${task.source}`,
        `priority=${priorityText(task.priority)}`,
        task.ref === null ? undefined : `ref=${task.ref}`,
        task.due === null ? undefined : `due=${task.due}`,
        task.week === null ? undefined : `week=${task.week}`,
        task.goals.length === 0 ? undefined : `goals=${task.goals.join(',')}`,
      ]
        .filter((part) => part !== undefined)
        .join(' ');
    }
    case 'status':
      return [
        `${head} ${event.status}${note}`,
        event.evidence === null ? undefined : `evidence=${event.evidence}`,
        event.skill === null ? undefined : `skill=${event.skill}`,
      ]
        .filter((part) => part !== undefined)
        .join(' ');
    case 'update': {
      const fields = Object.entries(event.changes).map(([name, value]) => `${name}=${changeText(name, value)}`);
      return `${head} ${fields.join(' ')}${note}`;
    }
  }
}

/** `show`: the task line, its status details, then its history. */
export function formatTaskDetail(task: Task, events: readonly RegisterEvent[]): string {
  const lines = [formatTask(task)];
  if (task.ref !== null) {
    lines.push(`ref: ${task.ref}`);
  }
  if (task.note !== null) {
    lines.push(`note: ${task.note}`);
  }
  if (task.evidence !== null) {
    lines.push(`evidence: ${task.evidence}`);
  }
  if (task.skill !== null) {
    lines.push(`skill: ${task.skill}`);
  }
  lines.push('history:', ...events.filter((event) => event.id === task.id).map((event) => `  ${formatEvent(event)}`));
  return lines.join('\n');
}
