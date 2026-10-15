import { isRecord, type JsonRecord } from '../core/guards.ts';
import { parseUtcDeadline, shortUtc } from '../core/time.ts';
import { TASK_ID, type TaskStatus } from './model.ts';

/**
 * What a waiting task waits for, each a typed reason, and when a reason clears:
 * - `decision` and `approval` name who must give it: a session id or the owner's marker. Only the task's owner
 *   knows when it came, so they clear when the owner sets a new status;
 * - `task` names a task that must finish first. Only a task already started can wait on one: a task that
 *   needs another before it starts stays open with a plan dependency (`after`) instead. It is ready once that
 *   task is done or dropped;
 * - `time` is a UTC minute (`YYYY-MM-DD HH:MM`, a bare day meaning its end). It is ready once that time passed.
 * A task stays waiting until its owner sets a new status, which clears every reason; `check` flags a waiting
 * task whose reasons are all ready.
 */
export const WAIT_KINDS = ['decision', 'approval', 'task', 'time'] as const;

export type WaitKind = (typeof WAIT_KINDS)[number];

/** The kinds whose reason names who must act. */
export type PersonWaitKind = 'decision' | 'approval';

export type WaitReason =
  | { readonly kind: PersonWaitKind; readonly who: string }
  | { readonly kind: 'task'; readonly id: string }
  | { readonly kind: 'time'; readonly at: string };

/** How a reason is typed on the CLI and printed in a task's history: `decision:owner`, `task:T5`, `time:2030-01-09 12:00`. */
export function waitSpelling(reason: WaitReason): string {
  switch (reason.kind) {
    case 'decision':
    case 'approval':
      return `${reason.kind}:${reason.who}`;
    case 'task':
      return `task:${reason.id}`;
    case 'time':
      return `time:${reason.at}`;
  }
}

/** True when both name the same thing to wait for, so a list never holds one twice. */
export function sameWait(a: WaitReason, b: WaitReason): boolean {
  return waitSpelling(a) === waitSpelling(b);
}

export function isWaitKind(value: unknown): value is WaitKind {
  return WAIT_KINDS.some((kind) => kind === value);
}

/** A typed reason read from text, shape only (who is named, a task id, a valid time); a problem is returned as text. */
export function waitOf(kind: WaitKind, value: string): WaitReason | string {
  switch (kind) {
    case 'decision':
    case 'approval':
      return value === '' ? `${kind} needs who gives it` : { kind, who: value };
    case 'task':
      return TASK_ID.test(value) ? { kind, id: value } : `${value} is not a task id like T12`;
    case 'time':
      return parseUtcDeadline(value) === undefined ? `${value} is not YYYY-MM-DD or YYYY-MM-DD HH:MM` : { kind, at: value };
  }
}

/** A stored `waits` list, format only: a list of `{kind, who|id|at}` records. A problem is returned as text. */
export function parseWaits(value: unknown): readonly WaitReason[] | string {
  if (!Array.isArray(value)) {
    return 'waits is not a list';
  }
  const reasons: WaitReason[] = [];
  for (const item of value) {
    const reason = isRecord(item) ? storedWait(item) : 'a wait is not an object';
    if (typeof reason === 'string') {
      return reason;
    }
    reasons.push(reason);
  }
  return reasons;
}

/** The field each kind of reason stores its value in. */
const VALUE_FIELD: Readonly<Record<WaitKind, string>> = { decision: 'who', approval: 'who', task: 'id', time: 'at' };

function storedWait(record: JsonRecord): WaitReason | string {
  const kind = record['kind'];
  if (!isWaitKind(kind)) {
    return `unknown wait kind ${JSON.stringify(kind)}`;
  }
  const value = record[VALUE_FIELD[kind]];
  return typeof value === 'string' ? waitOf(kind, value) : `a ${kind} wait has no ${VALUE_FIELD[kind]}`;
}

/** What a reader knows when it judges a reason ready: the time, and the status of each task it read. */
export interface WaitContext {
  readonly now: number;
  /** A task's status; undefined when the read lacks it, which a write never names unless a compaction retired it: finished. */
  statusOf(id: string): TaskStatus | undefined;
}

/** The context of one register read at `now`. */
export function waitContext(tasks: ReadonlyMap<string, { readonly status: TaskStatus }>, now: Date): WaitContext {
  return { now: now.getTime(), statusOf: (id) => tasks.get(id)?.status };
}

/** True when the task is done or dropped, or retired from the read, which only a finished task is. */
export function isFinished(id: string, context: WaitContext): boolean {
  const status = context.statusOf(id);
  return status === undefined || status === 'done' || status === 'dropped';
}

/** A task reason once its task finished, a time once it passed; a decision or an approval never: its owner says. */
export function isReady(reason: WaitReason, context: WaitContext): boolean {
  switch (reason.kind) {
    case 'decision':
    case 'approval':
      return false;
    case 'task':
      return isFinished(reason.id, context);
    case 'time':
      return (parseUtcDeadline(reason.at)?.getTime() ?? Number.POSITIVE_INFINITY) <= context.now;
  }
}

/** True when a task waits on reasons that are all ready, so its owner can go on. */
export function allReady(waits: readonly WaitReason[], context: WaitContext): boolean {
  return waits.length > 0 && waits.every((reason) => isReady(reason, context));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** `Thu 10-16 13:00`: a stored UTC time with its weekday and without its year. */
export function weekdayUtc(at: string): string {
  const date = parseUtcDeadline(at);
  const day = date === undefined ? undefined : WEEKDAYS[date.getUTCDay()];
  return day === undefined ? shortUtc(at) : `${day} ${shortUtc(at)}`;
}

/** One reason in plain words: `decision owner`, `approval lead`, `on T304`, `until Thu 10-16 13:00`; `ready` follows a ready one. */
export function waitText(reason: WaitReason, context?: WaitContext): string {
  const words = reason.kind === 'task' ? `on ${reason.id}` : reason.kind === 'time' ? `until ${weekdayUtc(reason.at)}` : `${reason.kind} ${reason.who}`;
  return context !== undefined && isReady(reason, context) ? `${words} ready` : words;
}

/** Every reason in plain words, joined by ` · `; without a context, no reason reads ready. */
export function waitsText(waits: readonly WaitReason[], context?: WaitContext): string {
  return waits.map((reason) => waitText(reason, context)).join(' · ');
}

/** The tasks of a plan dependency (`after T5,T6`) not finished yet: while any is left, the task is not free to start. */
export function unfinishedAfter(after: readonly string[], context: WaitContext): string[] {
  return after.filter((id) => !isFinished(id, context));
}
