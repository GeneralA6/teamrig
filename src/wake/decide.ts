import { formatPct, formatW } from '../budget/format.ts';
import { isPastDailyBudget, quietStartOf, sessionQuietFrom, type BudgetFacts } from '../budget/warn.ts';
import { DEFAULT_MESSAGES } from '../config/defaults.ts';
import type { QuietHours } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import { isCold } from '../hooks/cold-send.ts';
import { taskNumber, type Task } from '../register/fold.ts';
import type { TaskStatus } from '../register/model.ts';
import { unfinishedAfter, waitContext, type WaitContext } from '../register/waits.ts';

/**
 * Waking a session idle at its prompt when work is handed to it, pure. A wake is a model turn, so only work the
 * session can start now and has not seen wakes it: its own task, open or started (not waiting, verifying or
 * finished), at `wake.priority` or more urgent, with every task it comes after finished, and changed by someone
 * else since the session last touched it (handed to it, raised, reopened, or freed by another's finish). Each task
 * wakes a session once, tasks handed together wake it once (`wake.batchSeconds`), and wakes of one session are
 * `wake.minGapMinutes` apart. The plugin's mod asks `hook wake-check` while no turn runs and submits the prompt.
 */

/**
 * What a wake costs in weighted tokens (W): its first call re-reads the session's context, from Claude Code's
 * prompt cache while warm and at full price once cold, about eight times as much (the cold-send hook's ratio).
 */
export const WARM_WAKE_W = 27_000;
export const COLD_WAKE_W = 210_000;

/** The most tasks a wake names; the rest are counted. */
export const WAKE_LIST_MAX = 5;
/** The most characters of a task's title a wake shows. */
export const WAKE_TITLE_MAX = 80;

/** The statuses whose work can start now: a waiting, verifying or finished task never wakes. */
const WAKE_STATUSES: readonly TaskStatus[] = ['open', 'in-progress'];

/** The most urgent priority: what a session past its budget or in quiet hours still wakes for. */
export const URGENT_PRIORITY = 1;

/** True when the task is the session's, can start now, and is urgent enough to wake it. */
export function isWakeWorthy(task: Task, session: string, maxPriority: number, context: WaitContext): boolean {
  return (
    task.owner === session &&
    WAKE_STATUSES.includes(task.status) &&
    task.priority <= maxPriority &&
    unfinishedAfter(task.after, context).length === 0
  );
}

function timeOf(at: string | null): number {
  return at === null ? Number.NEGATIVE_INFINITY : Date.parse(at);
}

/**
 * True when someone else changed the task since its owner last touched it: handed it over, raised its priority,
 * set its status, or finished a task it comes after. The owner's own changes are never news to it.
 */
export function isNews(task: Task, session: string, tasks: ReadonlyMap<string, Task>): boolean {
  const seen = timeOf(task.ownerSeenAt);
  if (Math.max(timeOf(task.assignedAt), timeOf(task.priorityAt), timeOf(task.statusAt)) > seen) {
    return true;
  }
  return task.after.some((id) => {
    const before = tasks.get(id);
    return before !== undefined && before.updatedBy !== session && timeOf(before.statusAt) > seen;
  });
}

/** Tasks a wake is due for since `since`, epoch ms. */
export interface WakePending {
  readonly since: number;
  readonly ids: readonly string[];
}

/** The day's moments that already gave the session its turn (src/wake/day-start.ts), so each wakes it once. */
export interface SettledMoments {
  /** The last day start settled, epoch ms: woken for, or one the session had a turn after. */
  readonly dayStart: number | undefined;
  /** The `at` of the last burst settled. */
  readonly burst: number | undefined;
}

export const NO_SETTLED_MOMENTS: SettledMoments = { dayStart: undefined, burst: undefined };

/** What the wake check keeps per session between checks. */
export interface WakeState {
  /** The Claude Code session the state is for: another tab, or a /clear, starts it over. */
  readonly tab: string;
  /** The tasks that could wake the session at the last check: each wakes it once, when it joins this set. */
  readonly known: readonly string[];
  readonly pending: WakePending | undefined;
  readonly lastWakeAt: number | undefined;
  /** Kept across tabs like `lastWakeAt`, so a /clear never wakes the session twice for one moment. */
  readonly settled: SettledMoments;
}

export interface WakeInput {
  readonly tasks: ReadonlyMap<string, Task>;
  readonly session: string;
  readonly tab: string;
  readonly now: number;
  readonly maxPriority: number;
  readonly batchMs: number;
  readonly minGapMs: number;
  readonly previous: WakeState | undefined;
}

export type WakeVerdict =
  | { readonly kind: 'none' }
  | { readonly kind: 'later'; readonly at: number; readonly ids: readonly string[] }
  | { readonly kind: 'wake'; readonly tasks: readonly Task[] };

export interface WakeDecision {
  readonly verdict: WakeVerdict;
  readonly state: WakeState;
}

/** Most urgent first, then oldest. */
export function byUrgency(a: Task, b: Task): number {
  return a.priority - b.priority || taskNumber(a.id) - taskNumber(b.id);
}

/**
 * Whether to wake the session now, later or not, and the state to keep. A first check in a tab takes what is
 * there as known: work from before the tab started is seen at its first prompt, as it always was.
 */
export function decideWake(input: WakeInput): WakeDecision {
  const { tasks, session, tab, now, previous } = input;
  const context = waitContext(tasks, new Date(now));
  const worthy = [...tasks.values()].filter((task) => isWakeWorthy(task, session, input.maxPriority, context));
  const known = worthy.map((task) => task.id);
  const none: WakeVerdict = { kind: 'none' };
  const settled = previous?.settled ?? NO_SETTLED_MOMENTS;
  if (previous?.tab !== tab) {
    return { verdict: none, state: { tab, known, pending: undefined, lastWakeAt: previous?.lastWakeAt, settled } };
  }
  const wasKnown = new Set(previous.known);
  const pendingIds = new Set(previous.pending?.ids ?? []);
  const kept = worthy.filter((task) => pendingIds.has(task.id) && isNews(task, session, tasks));
  const fresh = worthy.filter((task) => !wasKnown.has(task.id) && isNews(task, session, tasks));
  const due = [...kept, ...fresh].sort(byUrgency);
  if (due.length === 0) {
    return { verdict: none, state: { tab, known, pending: undefined, lastWakeAt: previous.lastWakeAt, settled } };
  }
  const since = kept.length > 0 && previous.pending !== undefined ? previous.pending.since : now;
  const gapEnd = previous.lastWakeAt === undefined ? Number.NEGATIVE_INFINITY : previous.lastWakeAt + input.minGapMs;
  const at = Math.max(since + input.batchMs, gapEnd);
  const ids = due.map((task) => task.id);
  if (now < at) {
    return { verdict: { kind: 'later', at, ids }, state: { tab, known, pending: { since, ids }, lastWakeAt: previous.lastWakeAt, settled } };
  }
  return { verdict: { kind: 'wake', tasks: due }, state: { tab, known, pending: undefined, lastWakeAt: now, settled } };
}

/** Whether the session should rest: past its daily budget, or in the budget's quiet hours. */
export interface WakeRest {
  readonly over: boolean;
  readonly quiet: boolean;
}

/**
 * Where the session stands against its budget at `now`: past its daily budget (its lift's while lifted), and in
 * quiet hours unless its lift exempts it. With no facts (the week's use is not known yet) it is never past budget,
 * and quiet hours go by the clock alone.
 */
export function wakeRestOf(facts: BudgetFacts | undefined, quietHours: QuietHours | undefined, now: number): WakeRest {
  if (facts === undefined) {
    return { over: false, quiet: quietStartOf(quietHours, now) !== undefined };
  }
  return { over: isPastDailyBudget(facts), quiet: sessionQuietFrom(facts, quietHours) !== undefined };
}

/** The least urgent priority that wakes the session now: p1 only while it is past its daily budget or in quiet hours. */
export function effectivePriority(configured: number, rest: WakeRest): number {
  return rest.over || rest.quiet ? Math.min(configured, URGENT_PRIORITY) : configured;
}

/** What a wake costs. */
export interface WakeCost {
  readonly w: number;
  readonly cold: boolean;
  /** In % of the weekly limit; undefined without `budget.weeklyLimitW`. */
  readonly weekPct: number | undefined;
}

/**
 * The cost of waking a session idle `idleMs` (undefined: unknown, counted cold). It is cold past
 * `messages.coldAfterMinutes`; a team that set that to 0 (no held sends) still has a cache that expires, so the
 * default applies then.
 */
export function wakeCost(idleMs: number | undefined, coldAfterMinutes: number, weeklyLimitW: number | undefined): WakeCost {
  const after = coldAfterMinutes > 0 ? coldAfterMinutes : DEFAULT_MESSAGES.coldAfterMinutes;
  const cold = idleMs === undefined || isCold(idleMs, after);
  const w = cold ? COLD_WAKE_W : WARM_WAKE_W;
  return { w, cold, weekPct: weeklyLimitW === undefined || weeklyLimitW <= 0 ? undefined : (w / weeklyLimitW) * 100 };
}

/** The smallest share of the week `formatPct` shows as more than 0.00%. */
const LEAST_PCT = 0.01;

/** `about 27k W, warm cache, under 0.01% of the week`. */
export function costText(cost: WakeCost): string {
  const week =
    cost.weekPct === undefined ? '' : cost.weekPct < LEAST_PCT ? `, under ${formatPct(LEAST_PCT)} of the week` : `, ${formatPct(cost.weekPct)} of the week`;
  return `about ${formatW(cost.w)} W, ${cost.cold ? 'cold' : 'warm cache'}${week}`;
}

function shortTitle(title: string): string {
  return title.length <= WAKE_TITLE_MAX ? title : `${title.slice(0, WAKE_TITLE_MAX - 3)}...`;
}

/** `T12 "Fix the login" (p1), T13 "..." (p1) and 2 more`. */
export function taskListText(tasks: readonly Task[]): string {
  const named = tasks.slice(0, WAKE_LIST_MAX).map((task) => `${task.id} "${shortTitle(task.title)}" (p${task.priority})`);
  const more = tasks.length - named.length;
  return more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ');
}

/** The prompt the session reads, under the plugin's name. */
export function wakePrompt(session: string, tasks: readonly Task[], cost: WakeCost): string {
  return (
    `New work was handed to you while this tab was idle: ${taskListText(tasks)}. ` +
    `Start a work block (\`${KIT_NAME} start --session ${session}\`) and work your list in priority order. ` +
    `This wake costs ${costText(cost)}.`
  );
}

/** `T12, T13 and 2 more`. */
export function idsText(tasks: readonly Task[]): string {
  const named = tasks.slice(0, WAKE_LIST_MAX).map((task) => task.id);
  const more = tasks.length - named.length;
  return more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ');
}

/** The person's toast: which tasks woke the tab and what it costs. */
export function wakeToast(tasks: readonly Task[], cost: WakeCost): string {
  return `${KIT_NAME} woke this tab for ${idsText(tasks)} (${costText(cost)})`;
}
