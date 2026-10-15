import { formatUtcMinute, parseUtcDeadline, shortUtc } from '../core/time.ts';
import type { RegisterEvent } from './events.ts';
import { taskNumber, type Task } from './fold.ts';
import { ACTIVE_STATUSES, priorityText, type TaskStatus } from './model.ts';
import { GITHUB_SOURCE } from './policy.ts';
import { waitsText, type WaitContext } from './waits.ts';
import { proofOf, proofText } from './verify.ts';

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

/**
 * The fields every task row starts with: `T12 in-progress`, `p2`, `owner alpha`, then `due 01-15` and
 * `after T5,T6` (its plan dependency) when it has them.
 */
function rowHead(task: Task, team: string | undefined): string[] {
  const parts = [`${taskLabel(task, team)} ${task.status}`, priorityText(task.priority), `owner ${task.owner}`];
  if (task.due !== null) {
    parts.push(`due ${shortUtc(task.due)}`);
  }
  if (task.after.length > 0) {
    parts.push(`after ${task.after.join(',')}`);
  }
  return parts;
}

/** How long a proof runs in the one-line verify queue before it is cut. */
const SUMMARY_PROOF_CHARS = 60;

/** `VERIFY 2: T1 (proof: ...), T3 (proof: ...)`: a verify queue in one line, each proof cut short; undefined when empty. */
export function formatVerifySummary(queue: readonly Task[]): string | undefined {
  const named = queue.map((task) => `${task.id} (proof: ${cut(proofText(task), SUMMARY_PROOF_CHARS)})`);
  return queue.length === 0 ? undefined : `VERIFY ${queue.length}: ${named.join(', ')}`;
}

/** A row of `verify`: `T1 since 01-07 10:00, verify by 01-09 | <title> (proof: ...)`. */
export function formatVerifyRow(task: Task): string {
  const by = task.due === null ? 'no verify-by date' : `verify by ${shortUtc(task.due)}`;
  return `${task.id} since ${shortUtc(formatUtcMinute(new Date(task.statusAt)))}, ${by} | ${task.title} (proof: ${proofText(task)})`;
}

/** The Stop hook's line once a verifying task's verify-by day has come. */
export function formatVerifyByLine(task: Task): string {
  return `VERIFY ${task.id} was to be verified by ${shortUtc(task.due ?? '')} (proof: ${proofText(task)}): done with the proof, or back to in-progress`;
}

/** `text` cut to `max` characters, counted in code points so a character is never split, ending in `…` when cut. */
export function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * The short row of `list` and `check`: `T12 in-progress, p2, owner alpha, due 01-15 | <title cut to titleChars>`,
 * and what a waiting task waits for: `(waiting: decision owner · on T5 ready)`. It keeps what orders and assigns
 * the work, and the issue of a task imported from GitHub (`from gh:acme/web#7`) so it can be found there; it leaves
 * the week, other sources, goals and status note to `show`. `context` marks the ready reasons.
 */
export function formatShortTask(task: Task, titleChars: number, team?: string, context?: WaitContext): string {
  const waits = task.status === 'waiting' && task.waits.length > 0 ? ` (waiting: ${waitsText(task.waits, context)})` : '';
  const issue = issueOf(task);
  const head = issue === undefined ? rowHead(task, team) : [...rowHead(task, team), `from ${issue}`];
  return `${head.join(', ')} | ${cut(task.title, titleChars)}${waits}`;
}

/** The GitHub issue a task was imported from, as its ref (`gh:acme/web#7`); undefined for any other task. */
function issueOf(task: Task): string | undefined {
  return task.source === GITHUB_SOURCE && task.ref !== null ? task.ref : undefined;
}

/**
 * One line that names each field, so a newcomer can read it:
 * `T12 in-progress, p2, owner alpha, due 01-15, week 01-13, from lead, goals G1 | title`; a task imported from
 * GitHub is `from` its issue (`from gh:acme/web#7`).
 * With `team`, the id reads `<team>/T12`; `context` marks a waiting task's ready reasons.
 */
export function formatTask(task: Task, team?: string, context?: WaitContext): string {
  const parts = rowHead(task, team);
  if (task.week !== null) {
    parts.push(`week ${shortUtc(task.week)}`);
  }
  parts.push(`from ${issueOf(task) ?? task.source}`);
  if (task.goals.length > 0) {
    parts.push(`goals ${task.goals.join(',')}`);
  }
  return `${parts.join(', ')} | ${task.title}${statusNote(task, context)}`;
}

/**
 * What a row adds for a status that waits on something: a waiting task's reasons, then its note
 * (`(waiting: decision owner · on T5; the schema first)`), or what will prove a verifying one.
 */
function statusNote(task: Task, context: WaitContext | undefined): string {
  if (task.status === 'waiting') {
    const parts = [task.waits.length > 0 ? waitsText(task.waits, context) : null, task.note].filter((part) => part !== null);
    return parts.length === 0 ? '' : ` (waiting: ${parts.join('; ')})`;
  }
  const proof = task.status === 'verifying' ? proofOf(task) : null;
  return proof === null ? '' : ` (proof: ${proof})`;
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
        task.after.length === 0 ? undefined : `after=${task.after.join(',')}`,
      ]
        .filter((part) => part !== undefined)
        .join(' ');
    }
    case 'status':
      return [
        `${head} ${event.status}${event.waits === undefined ? '' : ` waits="${waitsText(event.waits)}"`}${note}`,
        event.proof === undefined ? undefined : `proof="${event.proof}"`,
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

/** `show`: the task line, its status details, then its history; `context` marks a waiting task's ready reasons. */
export function formatTaskDetail(task: Task, events: readonly RegisterEvent[], context?: WaitContext): string {
  const lines = [formatTask(task, undefined, context)];
  if (task.ref !== null) {
    lines.push(`ref: ${task.ref}`);
  }
  if (task.note !== null) {
    lines.push(`note: ${task.note}`);
  }
  if (task.proof !== null) {
    lines.push(`proof: ${task.proof}`);
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

/** The inbox line a task's new owner gets, under the giver's name: `T5 is yours (p2, due 2030-01-10): Show the signup errors`. */
export function assignedNotice(task: Pick<Task, 'id' | 'priority' | 'due' | 'title'>): string {
  const due = task.due === null ? '' : `, due ${task.due}`;
  return `${task.id} is yours (${priorityText(task.priority)}${due}): ${task.title}`;
}
