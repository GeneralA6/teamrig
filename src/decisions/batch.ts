import type { DecisionsConfig } from '../config/types.ts';
import { MS_PER_DAY } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { asksOwner } from '../meeting/agenda.ts';
import type { Task } from '../register/fold.ts';
import type { TaskTree } from '../register/tree.ts';
import { taskLabel } from '../register/views.ts';

/**
 * The owner's decisions, asked in batches: a session that needs one sets its task waiting on the owner's decision or
 * approval, with its card, and goes on with other work; the lead asks the owner the waiting ones together, at its
 * batch times (`decisions.batchTimesUtc`), at the daily meeting, or once `decisions.batchAt` of them wait unasked,
 * and at once only for one due before the next batch. A wait counts as asked when it was set at or before the last
 * batch the lead asked (`decisions asked`, or a meeting's start): a task's `statusAt` stays put while it stays
 * waiting, so setting it waiting again with a new card does not ask it again.
 */

/** Milliseconds after midnight UTC of a valid `HH:MM`. */
function offsetOf(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return (hours * 60 + minutes) * 60_000;
}

/** Each batch time on the UTC day of `now` and the days either side of it, in time order. */
function timesAround(now: number, times: readonly string[]): number[] {
  const midnight = Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
  return [midnight - MS_PER_DAY, midnight, midnight + MS_PER_DAY].flatMap((day) => times.map((time) => day + offsetOf(time))).sort((a, b) => a - b);
}

/** The latest batch time at or before `now`; undefined with no batch times. */
export function lastBatchTime(now: number, times: readonly string[]): number | undefined {
  return timesAround(now, times).findLast((at) => at <= now);
}

/** The first batch time after `now`; undefined with no batch times. */
export function nextBatchTime(now: number, times: readonly string[]): number | undefined {
  return timesAround(now, times).find((at) => at > now);
}

/** One task waiting on the owner, with the team and the tree of the register that holds it. */
export interface OwnerWait {
  readonly task: Task;
  /** The team, for a wait of a register under the batch's own (`web/T5`); undefined for the batch's own. */
  readonly team: string | undefined;
  /** The dependency tree of its register's read: its effective due and its named tasks. */
  readonly tree: TaskTree;
}

/** Why a batch is due now: a wait due before the next batch, enough waits unasked, or a batch time passed over waits. */
export type BatchTrigger =
  | { readonly kind: 'deadline'; readonly task: Task; readonly team: string | undefined; readonly due: number }
  | { readonly kind: 'count'; readonly pending: number; readonly batchAt: number }
  | { readonly kind: 'time'; readonly at: number };

export interface DecisionBatch {
  /** The waits on the owner not yet asked: register by register, each in its plan order. */
  readonly pending: readonly OwnerWait[];
  /** The waits on the owner asked in an earlier batch and now past their effective due date, in the same order. */
  readonly overdue: readonly OwnerWait[];
  /** Why the batch is due now; undefined while it waits for the next one. */
  readonly trigger: BatchTrigger | undefined;
  /** The next batch time; undefined with none set, when the next batch is the daily meeting. */
  readonly nextAt: number | undefined;
}

/** One register whose waits on the owner a batch holds. */
export interface BatchRegister {
  /** The team, for another team's register; undefined for the reader's own. */
  readonly team: string | undefined;
  readonly tasks: Iterable<Task>;
  /** The dependency tree of the same read: effective dues and plan order. */
  readonly tree: TaskTree;
  /** The register's marker for the owner (`register.ownerSource`). */
  readonly ownerMarker: string;
  /** Its `register.requireDecisionCard`: a wait on the owner's decision names its gate, so an ungated one is left out (asksOwner). */
  readonly requireGate: boolean;
}

export interface BatchInput {
  /** The registers the lead asks the owner for, its own first. */
  readonly registers: readonly BatchRegister[];
  readonly now: number;
  /** When the lead last asked the owner a batch (askedAtOf); undefined: never. */
  readonly askedAt: number | undefined;
  readonly config: DecisionsConfig;
}

/** The batch the lead asks the owner next, and whether it is due now. */
export function decisionBatch(input: BatchInput): DecisionBatch {
  const { now, askedAt } = input;
  const waiting = input.registers.flatMap(ownerWaitsOf);
  const asked = (wait: OwnerWait): boolean => askedAt !== undefined && Date.parse(wait.task.statusAt) <= askedAt;
  const pending = waiting.filter((wait) => !asked(wait));
  const overdue = waiting.filter((wait) => asked(wait) && (wait.tree.dueTime(wait.task) ?? Number.POSITIVE_INFINITY) < now);
  const nextAt = nextBatchTime(now, input.config.batchTimesUtc);
  return { pending, overdue, trigger: triggerOf(input, pending, overdue, nextAt), nextAt };
}

/**
 * The batch's waits that the registers of `teams` hold, its trigger and next time kept: what a child team sees of the
 * batch the lead at its tree's root asks (T1018). A wait of the batch's own register is never one of them.
 */
export function waitsOfTeams(batch: DecisionBatch, teams: readonly string[]): DecisionBatch {
  const held = (wait: OwnerWait): boolean => wait.team !== undefined && teams.includes(wait.team);
  return { ...batch, pending: batch.pending.filter(held), overdue: batch.overdue.filter(held) };
}

/** A register's waits the lead asks the owner (asksOwner), in its plan order. */
function ownerWaitsOf({ team, tasks, tree, ownerMarker, requireGate }: BatchRegister): OwnerWait[] {
  return tree.inPlanOrder([...tasks].filter((task) => asksOwner(task, ownerMarker, requireGate))).map((task) => ({ task, team, tree }));
}

/**
 * A task's effective due time when it falls before the next batch (a day on when no batch time is set: the next
 * meeting), so the owner must hear it at once; undefined otherwise.
 */
export function dueBeforeNextBatch(task: Task, tree: TaskTree, now: number, nextAt: number | undefined): number | undefined {
  const due = tree.dueTime(task);
  return due !== undefined && due < (nextAt ?? now + MS_PER_DAY) ? due : undefined;
}

/**
 * The first reason the batch is due: a pending wait due before the next batch, else `batchAt` pending, else a batch
 * time passed over a wait already pending then or over an overdue one not asked since.
 */
function triggerOf(input: BatchInput, pending: readonly OwnerWait[], overdue: readonly OwnerWait[], nextAt: number | undefined): BatchTrigger | undefined {
  for (const { task, team, tree } of pending) {
    const due = dueBeforeNextBatch(task, tree, input.now, nextAt);
    if (due !== undefined) {
      return { kind: 'deadline', task, team, due };
    }
  }
  const { batchAt } = input.config;
  if (batchAt > 0 && pending.length >= batchAt) {
    return { kind: 'count', pending: pending.length, batchAt };
  }
  const last = lastBatchTime(input.now, input.config.batchTimesUtc);
  if (last === undefined) {
    return undefined;
  }
  const missed = pending.some((wait) => Date.parse(wait.task.statusAt) <= last) || (overdue.length > 0 && (input.askedAt ?? Number.NEGATIVE_INFINITY) < last);
  return missed ? { kind: 'time', at: last } : undefined;
}

/** Why the batch is due, for one line, its times on `zone`'s clock: `T5 is due Tue 01-08 23:59 UTC, before the next batch` (`web/T5` for another team's). */
export function triggerText(trigger: BatchTrigger, zone: TimeZone): string {
  switch (trigger.kind) {
    case 'deadline':
      return `${taskLabel(trigger.task, trigger.team)} is due ${zone.weekdayMinute(new Date(trigger.due))}, before the next batch`;
    case 'count':
      return `${trigger.pending} not yet asked, decisions.batchAt is ${trigger.batchAt}`;
    case 'time':
      return `the ${zone.weekdayMinute(new Date(trigger.at))} batch time passed`;
  }
}

/** When the next batch is, on `zone`'s clock: `the next batch Tue 01-08 13:03 UTC`, or the daily meeting with no batch time set. */
export function nextBatchText(batch: Pick<DecisionBatch, 'nextAt'>, zone: TimeZone): string {
  return batch.nextAt === undefined ? 'the next batch at the daily meeting' : `the next batch ${zone.weekdayMinute(new Date(batch.nextAt))}`;
}
