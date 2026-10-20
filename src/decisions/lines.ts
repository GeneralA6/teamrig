import { formatWeekdayMinute } from '../budget/format.ts';
import { cardFacts } from '../meeting/agenda.ts';
import type { Task } from '../register/fold.ts';
import type { TaskTree } from '../register/tree.ts';
import { dueBeforeNextBatch, nextBatchText, triggerText, type DecisionBatch } from './batch.ts';

/** What `decisions` prints a batch with. */
export interface BatchView {
  readonly batch: DecisionBatch;
  readonly tree: TaskTree;
  readonly byId: ReadonlyMap<string, Task>;
  /** The register's marker for the owner (`register.ownerSource`). */
  readonly ownerMarker: string;
  readonly command: string;
  readonly lead: string;
}

/** `DECISIONS 2 to ask owner, 1 asked and past due; BATCH DUE: <why>`, or `...; the next batch Tue 01-08 13:03 UTC`. */
export function batchHead(batch: DecisionBatch, ownerMarker: string): string {
  const when = batch.trigger === undefined ? nextBatchText(batch) : `BATCH DUE: ${triggerText(batch.trigger)}`;
  return `DECISIONS ${batch.pending.length} to ask ${ownerMarker}, ${batch.overdue.length} asked and past due; ${when}`;
}

/**
 * `decisions`: the head, then each wait's card facts, the ones not yet asked before the ones asked and past due, then
 * how to ask them and record the batch and each answer.
 */
export function batchLines(view: BatchView): string[] {
  const { batch, tree, byId, ownerMarker, command, lead } = view;
  const head = batchHead(batch, ownerMarker);
  if (batch.pending.length + batch.overdue.length === 0) {
    return [head];
  }
  const facts = (tasks: readonly Task[]): string[] => tasks.flatMap((task) => cardFacts(task, tree, byId));
  return [
    head,
    ...(batch.pending.length === 0 ? [] : ['NOT YET ASKED', ...facts(batch.pending)]),
    ...(batch.overdue.length === 0 ? [] : ['PAST DUE, asked before: ask again', ...facts(batch.overdue)]),
    `  Ask ${ownerMarker} these together, each card as it stands, each figure explained; then ${command} decisions asked --session ${lead} records the batch asked.`,
    `  Record each answer in the same turn: ${command} update <id> --note "${ownerMarker} decided: <decision>" --session ${lead}.`,
  ];
}

/** The lead's `check` line while a batch is due; none while it waits for the next. */
export function checkDecisionLines(batch: DecisionBatch, command: string, lead: string): string[] {
  if (batch.trigger === undefined) {
    return [];
  }
  return [`DECISIONS batch due (${triggerText(batch.trigger)}): ${batch.pending.length} to ask, ${batch.overdue.length} past due; ${command} decisions --session ${lead}`];
}

/** When the owner hears of a new wait on them: at once, in the batch due now, or in the next one. */
export type WaitTiming = { readonly kind: 'at-once'; readonly due: number } | { readonly kind: 'batch-due'; readonly why: string } | { readonly kind: 'next'; readonly when: string };

export function waitTiming(batch: DecisionBatch, task: Task, tree: TaskTree, now: number): WaitTiming {
  const due = dueBeforeNextBatch(task, tree, now, batch.nextAt);
  if (due !== undefined) {
    return { kind: 'at-once', due };
  }
  return batch.trigger === undefined ? { kind: 'next', when: nextBatchText(batch) } : { kind: 'batch-due', why: triggerText(batch.trigger) };
}

/** The end of the lead's inbox line of a new wait on the owner: `AT ONCE, due ... before the next batch`, `BATCH DUE: <why>` or `asked in the next batch ...`. */
export function timingText(timing: WaitTiming): string {
  switch (timing.kind) {
    case 'at-once':
      return `AT ONCE, due ${formatWeekdayMinute(timing.due)} before the next batch`;
    case 'batch-due':
      return `BATCH DUE: ${timing.why}`;
    case 'next':
      return `asked in ${timing.when}`;
  }
}
