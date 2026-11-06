import { isRecord, type JsonRecord } from '../core/guards.ts';
import { parseDeadline, parseUtcDeadline, showStored } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { TASK_ID, type TaskStatus } from './model.ts';

/**
 * What a waiting task waits for, each a typed reason, and when a reason clears:
 * - `decision` and `approval` name who must give it: the lead's id or the owner's marker (a peer's work is a
 *   task to wait on, see {@link isPeerWait}). Only the task's owner knows when it came, so they clear when the
 *   owner sets a new status;
 * - `task` names a task that must finish first. Only a task already started can wait on one: a task that
 *   needs another before it starts stays open with a plan dependency (`after`) instead. It is ready once that
 *   task is done or dropped;
 * - `time` is a stored minute in UTC (`YYYY-MM-DD HH:MM`) or a bare day of the team's zone, meaning its end there. It is
 *   ready once that time passed.
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

/** A decision or an approval: a reason that names who must act. */
export type PersonWait = Extract<WaitReason, { readonly kind: PersonWaitKind }>;

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

/** True when both lists name the same things to wait for, in any order. */
export function sameWaits(a: readonly WaitReason[], b: readonly WaitReason[]): boolean {
  return a.length === b.length && a.every((reason) => b.some((other) => sameWait(reason, other)));
}

/** True when `waits` names a reason `held` lacks; a reason dropped names nothing new. */
export function namesNewWait(held: readonly WaitReason[], waits: readonly WaitReason[]): boolean {
  return waits.some((reason) => !held.some((had) => sameWait(had, reason)));
}

/** Who answers each kind of person wait on a task of one owner's, besides the owner (`waitAnswerersOf`). */
export type WaitAnswerers = Readonly<Record<PersonWaitKind, readonly string[]>>;

/**
 * A decision or an approval asked of a peer: anyone but its kind's `answerers` (the task owner's leaders, and for an
 * approval the security reviewer) and the owner. A peer's work is a task to wait on (`task:T<id>`, which clears by
 * itself once that task finishes), so a write refuses such a wait; one an older teamrig wrote still reads, and `check`
 * flags it PEER-WAIT.
 */
export function isPeerWait(reason: WaitReason, answerers: WaitAnswerers, ownerSource: string): reason is PersonWait {
  return (reason.kind === 'decision' || reason.kind === 'approval') && !answerers[reason.kind].includes(reason.who) && reason.who !== ownerSource;
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

/** What a reader knows when it judges a reason ready: the time, the team's zone, and the status of each task it read. */
export interface WaitContext {
  readonly now: number;
  /** The team's zone: a stored day is a day of it, and times show in it. */
  readonly zone: TimeZone;
  /**
   * A task's status, from the read or, for an id it lacks, from another register of the team tree; undefined when no
   * register holds it, which a write never names unless a compaction retired it: finished.
   */
  statusOf(id: string): TaskStatus | undefined;
}

/**
 * The tasks the other registers of a team tree hold, by id (one numbering across the tree, T1139), as a read of one
 * register asks them for an id it lacks; a register outside a tree has none.
 */
export type StatusesElsewhere = ReadonlyMap<string, { readonly task: { readonly status: TaskStatus } }>;

/**
 * The context of one register read at `now`, in the team's `zone`; an id the read lacks reads its status from
 * `elsewhere`. The read wins an id both hold, which only a register numbered before its tree was can have.
 */
export function waitContext(tasks: ReadonlyMap<string, { readonly status: TaskStatus }>, now: Date, zone: TimeZone, elsewhere: StatusesElsewhere = new Map()): WaitContext {
  return { now: now.getTime(), zone, statusOf: (id) => (tasks.get(id) ?? elsewhere.get(id)?.task)?.status };
}

/** True when the task is done or dropped, or retired from every register, which only a finished task is. */
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
      return (parseDeadline(reason.at, context.zone)?.getTime() ?? Number.POSITIVE_INFINITY) <= context.now;
  }
}

/** True when a task waits on reasons that are all ready, so its owner can go on. */
export function allReady(waits: readonly WaitReason[], context: WaitContext): boolean {
  return waits.length > 0 && waits.every((reason) => isReady(reason, context));
}

/** `Thu 10-16 16:00 IDT`: a stored time in the team's zone, with its weekday and without its year. */
export function weekdayText(at: string, zone: TimeZone): string {
  const date = parseDeadline(at, zone);
  return date === undefined ? showStored(at, zone) : `${zone.weekday(date)} ${showStored(at, zone)}`;
}

/**
 * One reason in plain words, a time in `zone`: `decision owner`, `approval lead`, `on T304`, `until Thu 10-16 16:00 IDT`;
 * `ready` follows a ready one.
 */
export function waitText(reason: WaitReason, zone: TimeZone, context?: WaitContext): string {
  const words = reason.kind === 'task' ? `on ${reason.id}` : reason.kind === 'time' ? `until ${weekdayText(reason.at, zone)}` : `${reason.kind} ${reason.who}`;
  return context !== undefined && isReady(reason, context) ? `${words} ready` : words;
}

/** Every reason in plain words, joined by ` · `; without a context, no reason reads ready. */
export function waitsText(waits: readonly WaitReason[], zone: TimeZone, context?: WaitContext): string {
  return waits.map((reason) => waitText(reason, zone, context)).join(' · ');
}

/** The tasks of a plan dependency (`after T5,T6`) not finished yet: while any is left, the task is not free to start. */
export function unfinishedAfter(after: readonly string[], context: WaitContext): string[] {
  return after.filter((id) => !isFinished(id, context));
}
