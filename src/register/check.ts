import { MS_PER_DAY, MS_PER_HOUR, parseDayStart, showStored } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { topPriority } from '../config/priorities.ts';
import type { LeadTree } from '../config/lead-tree.ts';
import type { RegisterCheckConfig, RegisterConfig } from '../config/types.ts';
import { approvalCleared } from './approval.ts';
import { CARD_FLAGS, whyAskUsage } from './card.ts';
import { taskNumber, type Task } from './fold.ts';
import { ACTIVE_STATUSES, priorityText } from './model.ts';
import { loopFix, pathText, TaskTree } from './tree.ts';
import { formatTask } from './views.ts';
import { allReady, isPeerWait, isReady, unfinishedAfter, waitSpelling, type WaitContext } from './waits.ts';

/** In report order: the most urgent first. */
export const FLAG_KINDS = [
  'OVERDUE',
  'VERIFY-OVERDUE',
  'LOOP',
  'VERIFY-BLOCKS',
  'READY',
  'NO-REASON',
  'PEER-WAIT',
  'NO-CARD',
  'OWNER-ORDERED',
  'NOT-PICKED-UP',
  'PRIORITY-SKIP',
  'SELF-MADE',
  'PILE-UP',
  'OVER-LIMIT',
  'OWNER-UNPLANNED',
  'DUE-UNPLANNED',
  'OFF-GOAL',
  'STOPGAP-DONE',
  'STALE',
] as const;

export type FlagKind = (typeof FLAG_KINDS)[number];

export interface Flag {
  readonly kind: FlagKind;
  readonly task: Task;
  readonly detail: string;
}

/**
 * The daily flags over active tasks:
 * - OVERDUE: past its effective deadline (its own due, or an earlier one of a task that needs it, named in the detail
 *   as `due 01-10, from T5`); VERIFY-OVERDUE when the task is verifying: that date is the date to verify it by;
 * - LOOP: the lowest-numbered task of a loop among active tasks (`T2 -> T5 -> T2`), which none of them can finish:
 *   rows an older teamrig wrote, or links set before the register refused loops; the detail names how its first
 *   link goes;
 * - VERIFY-BLOCKS: verifying, and another active task is planned after it or waits on it, so that work cannot start
 *   until the proof comes (`set` refuses its start);
 * - READY: waiting, and every reason it waits for is ready (its tasks finished, its time passed), so its owner can
 *   go on: only the owner clears a decision or an approval, by setting the next status, though the lead's yes to an
 *   approval wait (`approve`) counts as ready, so its owner pushes or merges it; or verifying, and every
 *   reason its proof waited for is ready, so the proof should exist: its owner verifies it now;
 * - NO-REASON: waiting with no reason, as a line from an older teamrig reads: nothing says what it waits for;
 * - NO-CARD: waiting on the owner's decision or approval with no card to decide from (card.ts), as one set before
 *   cards, or while `requireDecisionCard` was off, reads; never with that switch off;
 * - OWNER-ORDERED: a task the owner ordered (its source is `ownerSource`) waiting, or its proof waiting, on the
 *   owner's decision or approval with no card saying why the owner is asked (`whyAsk`, card.ts): an owner's order
 *   approves its own work and proof unless the order must change, the work needs something new, or only the owner
 *   can see the result (T802);
 * - NOT-PICKED-UP: assigned longer ago than `notPickedUpAfterHours` with no event from its owner since
 *   (an idle session never reads its inbox, so it needs a direct wake);
 * - PRIORITY-SKIP: in progress below an open task of the top priority that has the same owner and is free to start
 *   (every task it comes after finished), for longer than `prioritySkipAfterHours`: the session is not working its
 *   list in order;
 * - SELF-MADE: the first task still active past `maxSelfMadePerDay` of the tasks its owner added for itself (created
 *   by it, asked by no one else) in the 24 h before now (0 turns it off): a session adding its own work faster than
 *   anything asked for it may be looping or drifting from its goal;
 * - PILE-UP: the oldest verifying task of an owner holding more than `maxVerifying` of them (0 turns it off): shipped
 *   changes pile up unproven;
 * - STALE: no event for `staleAfterHours` (not raised on top of NOT-PICKED-UP, nor for a verifying task with an
 *   effective due date: it waits quietly for its proof, and the date raises the alarm, nor for a waiting task with a
 *   time still to come: it is parked until then);
 * - OWNER-UNPLANNED: an owner order outside the current week plan;
 * - DUE-UNPLANNED: effectively due inside the current week but outside its plan;
 * - OFF-GOAL: in progress with no goal and outside the current week plan, so nothing the team planned asked
 *   for it. The register has no parent tasks: a goal tag or the week plan is what ties a task to the plan.
 * The three week flags need a week; null skips them, and each task gets at most one of them.
 */

export function checkTasks(tasks: Iterable<Task>, now: Date, zone: TimeZone, week: string | null, config: RegisterConfig): Flag[] {
  const at = now.getTime();
  const all = [...tasks];
  const tree = new TaskTree(new Map(all.map((task) => [task.id, task])), now, zone, week);
  const active = tree.inPlanOrder(all.filter((candidate) => ACTIVE_STATUSES.includes(candidate.status)));
  const plan = weekPlan(week, config.check.weekLengthDays, zone);
  const top = topPriority(config.priorities);
  const waiting = top === undefined ? new Map<string, Task>() : waitingTopTasks(active, top, tree.context);
  const piles = pileUps(active, config.maxVerifying);
  const runs = selfMadeRuns(all, at, config.check.maxSelfMadePerDay);
  const flags = active.flatMap((task) => [
    ...verifyFlags(task, tree, piles, config.maxVerifying),
    ...selfMadeFlags(task, runs, config.check.maxSelfMadePerDay),
    ...readyFlags(task, tree.context),
    ...(task.status === 'waiting' && task.waits.length === 0 ? [{ kind: 'NO-REASON' as const, task, detail: 'set what it waits for (--waits) or its next status' }] : []),
    ...noCardFlags(task, config),
    ...ownerOrderedFlags(task, config.ownerSource),
    ...timeFlags(task, at, config.check, tree),
    ...(top === undefined ? [] : prioritySkip(task, top, waiting, at, config.check, zone)),
    ...(plan === undefined ? [] : planFlags(task, plan, config.ownerSource, tree)),
  ]);
  return [...flags, ...loopFlags(tree)].sort(byFlagKind);
}

/** Orders flags by FLAG_KINDS, most urgent first; the sort is stable, so each kind keeps its own order. */
export function byFlagKind(a: Flag, b: Flag): number {
  return FLAG_KINDS.indexOf(a.kind) - FLAG_KINDS.indexOf(b.kind);
}

/** One flag; with `team`, the task id reads `<team>/T12`; `tree` reads the task line as {@link formatTask} does. */
export function formatFlag(flag: Flag, team: string | undefined, tree: TaskTree): string {
  return `${flag.kind} (${flag.detail}) ${formatTask(flag.task, team, tree)}`;
}

interface WeekPlan {
  readonly week: string;
  readonly start: number;
  readonly end: number;
}

/**
 * PEER-WAIT: waiting (or a verifying task's proof waiting) on a decision or an approval of a peer (anyone but the
 * lead and the owner), as a line from an older teamrig reads: a peer's work is a task, waited on by its id, which
 * clears by itself once that task finishes. Apart from {@link checkTasks}, whose register config does not name the lead.
 */
export function peerWaitFlags(tasks: Iterable<Task>, tree: LeadTree, ownerSource: string): Flag[] {
  return [...tasks].flatMap((task) => {
    const approvers = tree.approversOf(task.owner);
    const peer = task.waits.find((reason) => isPeerWait(reason, approvers, ownerSource));
    return peer === undefined
      ? []
      : [{ kind: 'PEER-WAIT' as const, task, detail: `${waitSpelling(peer)} is a peer's work: wait on it by its task (set ${task.id} --status ${task.status} --ask ${peer.who} --text "<the work>")` }];
  });
}

function weekPlan(week: string | null, lengthDays: number, zone: TimeZone): WeekPlan | undefined {
  const start = week === null ? undefined : parseDayStart(week, zone)?.getTime();
  return week === null || start === undefined ? undefined : { week, start, end: start + lengthDays * MS_PER_DAY };
}

/** NO-CARD, as {@link checkTasks} describes it. */
function noCardFlags(task: Task, config: RegisterConfig): Flag[] {
  const { ownerSource } = config;
  const asksOwner = task.waits.some((reason) => (reason.kind === 'decision' || reason.kind === 'approval') && reason.who === ownerSource);
  return config.requireDecisionCard && task.card === null && asksOwner
    ? [{ kind: 'NO-CARD', task, detail: `no card for ${ownerSource} to decide from: set it ${task.status} again with ${CARD_FLAGS}` }]
    : [];
}

/** OWNER-ORDERED, as {@link checkTasks} describes it. */
function ownerOrderedFlags(task: Task, ownerSource: string): Flag[] {
  if (task.source !== ownerSource || task.card?.whyAsk !== undefined) {
    return [];
  }
  const kinds = [...new Set(task.waits.flatMap((reason) => ((reason.kind === 'decision' || reason.kind === 'approval') && reason.who === ownerSource ? [reason.kind] : [])))];
  return kinds.length === 0
    ? []
    : [
        {
          kind: 'OWNER-ORDERED',
          task,
          detail: `${ownerSource} ordered it, and an order approves its own work and proof: drop the wait on ${ownerSource}'s ${kinds.join(' and ')}, or set it ${task.status} again with ${whyAskUsage(ownerSource)}`,
        },
      ];
}

/**
 * READY, as {@link checkTasks} describes it: a waiting task's reasons, or a verifying task's proof waits, all cleared;
 * or a waiting task whose approval wait the one it waits on answered yes (`approve`, T684).
 */
function readyFlags(task: Task, context: WaitContext): Flag[] {
  if (allReady(task.waits, context)) {
    const detail = task.status === 'verifying' ? 'every wait of its proof cleared; verify it now' : 'every reason cleared; set its next status';
    return [{ kind: 'READY', task, detail }];
  }
  if (task.status === 'waiting' && task.waits.length > 0 && task.waits.every((reason) => isReady(reason, context) || approvalCleared(task, reason))) {
    return [{ kind: 'READY', task, detail: `${task.answer?.by ?? 'the lead'} approved it; push or merge it, then set its next status` }];
  }
  return [];
}

/** A task with a time reason still to come (waiting, or a verifying task's proof): parked on purpose until then, so not stale. */
function waitsForTime(task: Task, context: WaitContext): boolean {
  return task.waits.some((reason) => reason.kind === 'time' && !isReady(reason, context));
}

/** OVERDUE or VERIFY-OVERDUE on the effective due, then NOT-PICKED-UP or else STALE. */
function timeFlags(task: Task, at: number, check: RegisterCheckConfig, tree: TaskTree): Flag[] {
  const flags: Flag[] = [];
  const effective = tree.effectiveDue(task.id);
  const due = effective?.at;
  const verifying = task.status === 'verifying';
  if (effective !== undefined && effective.at < at) {
    const from = effective.from === null ? '' : `, from ${effective.from}`;
    flags.push({ kind: verifying ? 'VERIFY-OVERDUE' : 'OVERDUE', task, detail: `${verifying ? 'verify by' : 'due'} ${showStored(effective.due, tree.zone)}${from}` });
  }
  if (task.ownerSeenAt === null && at - Date.parse(task.assignedAt) > check.notPickedUpAfterHours * MS_PER_HOUR) {
    flags.push({ kind: 'NOT-PICKED-UP', task, detail: `assigned ${minute(task.assignedAt, tree.zone)}, no event from ${task.owner} since` });
  } else if (!(verifying && due !== undefined) && !waitsForTime(task, tree.context) && at - Date.parse(task.updatedAt) > check.staleAfterHours * MS_PER_HOUR) {
    flags.push({ kind: 'STALE', task, detail: `last event ${minute(task.updatedAt, tree.zone)} by ${task.updatedBy}` });
  }
  return flags;
}

/**
 * LOOP, once per loop among active tasks, on its first task, with how its first link goes: by `set --ask` when that
 * task waits on the next one, else by a new task it is planned after.
 */
function loopFlags(tree: TaskTree): Flag[] {
  return tree.loops().flatMap((loop) => {
    const [first, next] = loop;
    const task = first === undefined ? undefined : tree.task(first);
    const owner = next === undefined ? undefined : tree.task(next)?.owner;
    if (task === undefined || next === undefined || owner === undefined) {
      return [];
    }
    const fix = loopFix(task.id, next, owner, !task.after.includes(next));
    return [{ kind: 'LOOP' as const, task, detail: `${pathText(loop)} is a loop, and no task in a loop can finish: ${fix}` }];
  });
}

/** Per owner holding more than `max` verifying tasks (0: none), its count, keyed by the id of its oldest one. */
function pileUps(active: readonly Task[], max: number): Map<string, number> {
  const byOwner = new Map<string, Task[]>();
  for (const task of active.filter((candidate) => candidate.status === 'verifying')) {
    byOwner.set(task.owner, [...(byOwner.get(task.owner) ?? []), task]);
  }
  const piles = new Map<string, number>();
  for (const held of byOwner.values()) {
    const oldest = [...held].sort((a, b) => Date.parse(a.statusAt) - Date.parse(b.statusAt))[0];
    if (max > 0 && held.length > max && oldest !== undefined) {
      piles.set(oldest.id, held.length);
    }
  }
  return piles;
}

/** VERIFY-BLOCKS on a verifying task that active tasks need (planned after it or waiting on it), then PILE-UP on the oldest task of a pile. */
function verifyFlags(task: Task, tree: TaskTree, piles: ReadonlyMap<string, number>, max: number): Flag[] {
  const flags: Flag[] = [];
  const needs = task.status === 'verifying' ? tree.neededBy(task.id) : [];
  if (needs.length > 0) {
    const named = needs.map((needer) => `${needer.id} (owner ${needer.owner})`).join(', ');
    flags.push({ kind: 'VERIFY-BLOCKS', task, detail: `${named} ${needs.length === 1 ? 'needs' : 'need'} it; prove it or reopen it` });
  }
  const held = piles.get(task.id);
  if (held !== undefined) {
    flags.push({ kind: 'PILE-UP', task, detail: `${task.owner} holds ${held} verifying tasks, more than ${max}; this is the oldest` });
  }
  return flags;
}

/** Created by its owner and asked for by no one else: `add` takes the caller as the source unless `--source` names another. */
function isSelfMade(task: Task): boolean {
  return task.createdBy === task.owner && task.source === task.owner;
}

/**
 * Per owner that added more than `max` tasks for itself in the 24 h before `at` (0: none), its count, keyed by the id
 * of the first of them past `max` that is still active. A run whose surplus is all finished raises nothing: no work of
 * it is left to read.
 */
function selfMadeRuns(all: readonly Task[], at: number, max: number): Map<string, number> {
  const runs = new Map<string, number>();
  if (max === 0) {
    return runs;
  }
  const byOwner = new Map<string, Task[]>();
  for (const task of all) {
    const created = Date.parse(task.createdAt);
    if (isSelfMade(task) && created > at - MS_PER_DAY && created <= at) {
      byOwner.set(task.owner, [...(byOwner.get(task.owner) ?? []), task]);
    }
  }
  for (const made of byOwner.values()) {
    const surplus = [...made].sort((a, b) => taskNumber(a.id) - taskNumber(b.id)).slice(max);
    const first = surplus.find((task) => ACTIVE_STATUSES.includes(task.status));
    if (first !== undefined) {
      runs.set(first.id, made.length);
    }
  }
  return runs;
}

function selfMadeFlags(task: Task, runs: ReadonlyMap<string, number>, max: number): Flag[] {
  const made = runs.get(task.id);
  if (made === undefined) {
    return [];
  }
  return [{ kind: 'SELF-MADE', task, detail: `${task.owner} added ${made} tasks for itself in 24 h, more than ${max}; this is the first still active past ${max}` }];
}

/** Since when the task has stood where it is in its owner's list: its latest change of owner, status or priority. */
function standingSince(task: Task): number {
  return Math.max(Date.parse(task.assignedAt), Date.parse(task.statusAt), Date.parse(task.priorityAt));
}

/**
 * Per owner, the open task of the top priority, free to start, that has stood longest, so a skip over it counts from
 * the start. A task planned after one not finished yet is not free to start, so working below it skips nothing.
 */
function waitingTopTasks(active: readonly Task[], top: number, context: WaitContext): Map<string, Task> {
  const waiting = new Map<string, Task>();
  for (const task of active) {
    const held = waiting.get(task.owner);
    const free = task.status === 'open' && unfinishedAfter(task.after, context).length === 0;
    if (free && task.priority <= top && (held === undefined || standingSince(task) < standingSince(held))) {
      waiting.set(task.owner, task);
    }
  }
  return waiting;
}

/** PRIORITY-SKIP, counted from when both tasks took their current owner, status and priority. */
function prioritySkip(task: Task, top: number, waiting: ReadonlyMap<string, Task>, at: number, check: RegisterCheckConfig, zone: TimeZone): Flag[] {
  const skipped = waiting.get(task.owner);
  if (task.status !== 'in-progress' || task.priority <= top || skipped === undefined) {
    return [];
  }
  const since = Math.max(standingSince(task), standingSince(skipped));
  if (at - since <= check.prioritySkipAfterHours * MS_PER_HOUR) {
    return [];
  }
  return [{ kind: 'PRIORITY-SKIP', task, detail: `${priorityText(skipped.priority)} ${skipped.id} waits open, skipped since ${minute(since, zone)}` }];
}

/** OWNER-UNPLANNED, or else DUE-UNPLANNED (on the effective due), or else OFF-GOAL. */
function planFlags(task: Task, plan: WeekPlan, ownerSource: string, tree: TaskTree): Flag[] {
  if (task.week === plan.week) {
    return [];
  }
  if (task.source === ownerSource) {
    return [{ kind: 'OWNER-UNPLANNED', task, detail: `owner order not in week ${plan.week}` }];
  }
  const due = tree.dueTime(task);
  if (due !== undefined && due >= plan.start && due < plan.end) {
    return [{ kind: 'DUE-UNPLANNED', task, detail: `due inside week ${plan.week}, not in its plan` }];
  }
  if (task.status === 'in-progress' && task.goals.length === 0) {
    return [{ kind: 'OFF-GOAL', task, detail: `in progress with no goal, not in week ${plan.week}` }];
  }
  return [];
}

function minute(instant: string | number, zone: TimeZone): string {
  return zone.shortMinute(new Date(instant));
}
