import { parseDeadline } from '../core/time.ts';
import { proofWordOf } from './card.ts';
import type { Task } from './fold.ts';
import type { TaskTree } from './tree.ts';
import { isReady, type WaitContext } from './waits.ts';

/**
 * The tasks that wait on the owner, and which of them the lead asks now (T1295): a task waits on the owner while it
 * waits, or its proof waits, on the owner's decision or approval. The owner may put such a card off (Later): a time
 * wait beside it, still to come, keeps it out of the meeting's DECISIONS and out of a decision batch until that time
 * passed, when it counts as not asked yet. Pure, with no node: import, so the task pane vendors it (src/read/index.ts).
 */

/** Whether a task waits for a decision or an approval from the owner: a waiting one, or a verifying one's proof. */
export function waitsOnOwner(task: Task, ownerMarker: string): boolean {
  return task.waits.some((reason) => (reason.kind === 'decision' || reason.kind === 'approval') && reason.who === ownerMarker);
}

/**
 * Whether a task waits, or its proof waits, on the owner's decision with a card naming no owner gate or business
 * decision (T1194): while `register.requireDecisionCard` is on, the question is then its session's or its leader's,
 * never the owner's, so check flags it UNGATED and neither the meeting agenda's DECISIONS nor a decision batch asks
 * it. A task with no card is NO-CARD's.
 */
export function isUngated(task: Task, ownerMarker: string): boolean {
  return task.card !== null && task.card.gate === undefined && task.waits.some((reason) => reason.kind === 'decision' && reason.who === ownerMarker);
}

/**
 * Whether a task waits, or its proof waits, on the owner's decision or approval with a card whose question is about a
 * test, measure or proof (proofWordOf) and that names nothing it changes (`affects`, T2623): while
 * `register.requireDecisionCard` is on, such work of approved work is approved with it, so check flags it OWNER-PROOF
 * and neither the meeting agenda's DECISIONS nor a decision batch asks it.
 */
export function isProofAsk(task: Task, ownerMarker: string): boolean {
  return task.card !== null && task.card.affects === undefined && proofWordOf(task.card.question) !== undefined && waitsOnOwner(task, ownerMarker);
}

/** When a stored time wait passes, in ms; a time that does not parse, which a write never stores, never passes. */
function passesAt(at: string, context: WaitContext): number {
  return parseDeadline(at, context.zone)?.getTime() ?? Number.POSITIVE_INFINITY;
}

/** The latest of a task's time waits still to come, as stored (`2030-01-09 12:00` or a bare day); undefined when none is. */
export function deferredUntil(task: Task, context: WaitContext): string | undefined {
  let latest: string | undefined;
  for (const reason of task.waits) {
    if (reason.kind === 'time' && !isReady(reason, context) && (latest === undefined || passesAt(reason.at, context) > passesAt(latest, context))) {
      latest = reason.at;
    }
  }
  return latest;
}

/**
 * Since when the lead may ask a task's wait: its status time, or the newest of its time waits that passed when that
 * is later, so a card back from Later counts as not asked yet in a decision batch (src/decisions/batch.ts).
 */
export function askableSince(task: Task, context: WaitContext): number {
  const passed = task.waits.flatMap((reason) => (reason.kind === 'time' && isReady(reason, context) ? [passesAt(reason.at, context)] : []));
  return Math.max(Date.parse(task.statusAt), ...passed);
}

/**
 * Whether a task's wait is the owner's to hear at all: it waits on the owner (waitsOnOwner) and, while `requireGate`
 * (`register.requireDecisionCard`) is on, is neither ungated (isUngated, T1194) nor a proof ask (isProofAsk, T2623):
 * either is its session's or its leader's to decide.
 */
function onOwner(task: Task, ownerMarker: string, requireGate: boolean): boolean {
  return waitsOnOwner(task, ownerMarker) && !(requireGate && (isUngated(task, ownerMarker) || isProofAsk(task, ownerMarker)));
}

/** Whether the lead asks the owner a task's wait now: the owner's to hear (onOwner) and not put off (deferredUntil). */
export function asksOwner(task: Task, ownerMarker: string, requireGate: boolean, context: WaitContext): boolean {
  return onOwner(task, ownerMarker, requireGate) && deferredUntil(task, context) === undefined;
}

/**
 * Whether the owner decides a task's wait in a dedicated meeting with its session (T868): its owner holds one of the
 * team's core-business areas (`decisions.dedicatedOwners`), so no daily card or batch asks it.
 */
export function isDedicated(task: Pick<Task, 'owner'>, dedicatedOwners: readonly string[]): boolean {
  return dedicatedOwners.includes(task.owner);
}

/** When the lead asks the owner a wait the owner put off (Later), as stored; undefined for any other task. */
export function ownerLater(task: Task, ownerMarker: string, requireGate: boolean, context: WaitContext): string | undefined {
  return onOwner(task, ownerMarker, requireGate) ? deferredUntil(task, context) : undefined;
}

/** A card the owner put off (Later), with the time the lead asks it again, as stored. */
export interface LaterCard {
  readonly task: Task;
  readonly until: string;
}

/** One session's cards on the owner: those the lead asks now (asksOwner), then those the owner put off (ownerLater). */
export interface OwnerCards {
  readonly due: readonly Task[];
  readonly later: readonly LaterCard[];
}

/**
 * Each session's cards on the owner (T1295), keyed by the task's owner, each list in the register's plan order: what
 * `teamrig meet` asks a session about and the task pane's Team tab counts. A session with none is absent.
 */
export function ownerCardsBySession(tasks: readonly Task[], tree: TaskTree, ownerMarker: string, requireGate: boolean): ReadonlyMap<string, OwnerCards> {
  const bySession = new Map<string, { due: Task[]; later: LaterCard[] }>();
  for (const task of tree.inPlanOrder(tasks.filter((task) => onOwner(task, ownerMarker, requireGate)))) {
    const cards = bySession.get(task.owner) ?? { due: [], later: [] };
    const until = deferredUntil(task, tree.context);
    if (until === undefined) {
      cards.due.push(task);
    } else {
      cards.later.push({ task, until });
    }
    bySession.set(task.owner, cards);
  }
  return bySession;
}
