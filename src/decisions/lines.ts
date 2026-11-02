import type { TimeZone } from '../core/zone.ts';
import { cardFacts, laterLine } from '../meeting/agenda.ts';
import type { Task } from '../register/fold.ts';
import type { TaskTree } from '../register/tree.ts';
import { dueBeforeNextBatch, nextBatchText, triggerText, type BatchTrigger, type DecisionBatch, type OwnerWait } from './batch.ts';

/** What `decisions` prints a batch with. */
export interface BatchView {
  readonly batch: DecisionBatch;
  /** The register's marker for the owner (`register.ownerSource`). */
  readonly ownerMarker: string;
  readonly command: string;
  readonly lead: string;
  /** For a child team, the lead at its tree's root who asks the owner its waits (`app/lead`); undefined in a root team. */
  readonly askedBy: string | undefined;
  /** The team's clock, which the batch times print on. */
  readonly zone: TimeZone;
}

/** `DECISIONS 2 to ask owner, 1 asked and past due; BATCH DUE: <why>`, or `...; the next batch Tue 01-08 13:03 UTC`. */
export function batchHead(batch: DecisionBatch, ownerMarker: string, zone: TimeZone): string {
  const when = batch.trigger === undefined ? nextBatchText(batch, zone) : `BATCH DUE: ${triggerText(batch.trigger, zone)}`;
  return `DECISIONS ${batch.pending.length} to ask ${ownerMarker}, ${batch.overdue.length} asked and past due; ${when}`;
}

/**
 * `decisions`: the head, then each wait's card facts, the ones not yet asked before the ones asked and past due, then
 * how to ask them and record the batch and each answer; in a child team, who asks them and how each answer comes back.
 */
export function batchLines(view: BatchView): string[] {
  const { batch, ownerMarker, command, lead, askedBy, zone } = view;
  const head = batchHead(batch, ownerMarker, zone);
  if (batch.pending.length + batch.overdue.length === 0) {
    return [head];
  }
  const facts = (waits: readonly OwnerWait[]): string[] => waits.flatMap((wait) => cardFacts(wait.task, wait.tree, wait.team));
  const how =
    askedBy === undefined
      ? [
          `  Ask ${ownerMarker} these together, each card as it stands, each figure explained; then ${command} decisions asked --session ${lead} records the batch asked.`,
          `  Record each answer in the same turn: ${command} update <id> --decided --note "${ownerMarker} decided: <decision>" --session ${lead}; the card leaves the batches.`,
          laterLine(command, ownerMarker, lead, 'no batch asks it before then'),
        ]
      : [`  ${askedBy} asks ${ownerMarker} these in its batches and records each answer on its task as decided: "${ownerMarker} decided: <decision>".`];
  return [
    head,
    ...(batch.pending.length === 0 ? [] : ['NOT YET ASKED', ...facts(batch.pending)]),
    ...(batch.overdue.length === 0 ? [] : ['PAST DUE, asked before: ask again', ...facts(batch.overdue)]),
    ...how,
  ];
}

/** The lead's `check` line while a batch is due, its times on `zone`'s clock; none while it waits for the next. */
export function checkDecisionLines(batch: DecisionBatch, command: string, lead: string, zone: TimeZone): string[] {
  if (batch.trigger === undefined) {
    return [];
  }
  return [`DECISIONS batch due (${triggerText(batch.trigger, zone)}): ${batch.pending.length} to ask, ${batch.overdue.length} past due; ${command} decisions --session ${lead}`];
}

/** When the owner hears of a new wait on them: at once, in the batch due now, or in the next one. */
export type WaitTiming =
  | { readonly kind: 'at-once'; readonly due: number }
  | { readonly kind: 'batch-due'; readonly trigger: BatchTrigger }
  | { readonly kind: 'next'; readonly nextAt: number | undefined };

export function waitTiming(batch: DecisionBatch, task: Task, tree: TaskTree, now: number): WaitTiming {
  const due = dueBeforeNextBatch(task, tree, now, batch.nextAt);
  if (due !== undefined) {
    return { kind: 'at-once', due };
  }
  return batch.trigger === undefined ? { kind: 'next', nextAt: batch.nextAt } : { kind: 'batch-due', trigger: batch.trigger };
}

/**
 * The end of the lead's inbox line of a new wait on the owner, its times on `zone`'s clock: `AT ONCE, due ... before
 * the next batch`, `BATCH DUE: <why>` or `asked in the next batch ...`.
 */
export function timingText(timing: WaitTiming, zone: TimeZone): string {
  switch (timing.kind) {
    case 'at-once':
      return `AT ONCE, due ${zone.weekdayMinute(new Date(timing.due))} before the next batch`;
    case 'batch-due':
      return `BATCH DUE: ${triggerText(timing.trigger, zone)}`;
    case 'next':
      return `asked in ${nextBatchText(timing, zone)}`;
  }
}
