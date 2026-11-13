import { formatPct, formatW } from '../budget/format.ts';
import { MEASURED_DAYS, type MeasuredTurns } from '../budget/turn-average.ts';
import { isHeld, quietSpanOf, sessionQuietSpan, type BudgetFacts } from '../budget/warn.ts';
import { DEFAULT_MESSAGES } from '../config/defaults.ts';
import { NOW_PRIORITY } from '../config/priorities.ts';
import type { QuietHours } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import { parseDeadline } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import { isCold } from '../hooks/cold-send.ts';
import { answerTo } from '../register/approval.ts';
import { waitsLetGoOn } from '../register/can-move.ts';
import { taskNumber, type Task } from '../register/fold.ts';
import type { TaskStatus } from '../register/model.ts';
import { wouldPark, type ParkRules } from '../register/park.ts';
import { neededIds, type TasksElsewhere } from '../register/tree.ts';
import { unfinishedAfter, waitContext, type WaitContext } from '../register/waits.ts';

/**
 * Waking a session idle at its prompt when work is handed to it, pure. A wake is a model turn, so only work the
 * session can go on with now ({@link canGoOn}) and has not seen wakes it: its own task at `wake.priority` or more
 * urgent (p0 only while its budget holds or a short day pauses it, p1 and p0 in quiet hours, p0 alone when they block: {@link effectivePriority}), changed by
 * someone else or by the clock since the session last touched it (handed to it, raised,
 * reopened, freed by another's finish, its waits cleared, or an approval it waits on answered). Each task wakes a
 * session once, tasks handed together wake it once (`wake.batchSeconds`), and wakes of one session are
 * `wake.minGapMinutes` apart. The plugin's mod asks `hook wake-check` while no turn runs and submits the prompt. A
 * parked task (src/register/park.ts) wakes nothing: `list` leaves it out, so a wake would send the session to work it
 * cannot find, and a task no owner touched stays news for ever. An event on it ends the parking, and with it the silence.
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

/**
 * The least urgent priority a session its budget holds still wakes for: p0, the only work the budget stop lets go on
 * (`queuedWork`'s urgent, src/budget/work.ts).
 */
export const HELD_PRIORITY = NOW_PRIORITY.id;

/** The least urgent priority a session in quiet hours still wakes for: p1, and p0 above it, unless they block. */
export const QUIET_PRIORITY = 1;

/**
 * The least urgent priority a session in quiet hours wakes or reopens for: p0 alone when their action is `block`, else
 * {@link QUIET_PRIORITY}. A blocking night ends no running turn chain, so a p1 wake there runs on until the morning:
 * on 11-12 the UTC day start (02:00 IST) freed every session's budget inside the quiet hours, and p1 reopens spent
 * about 4.4% of the week before 05:00 IST (T2500, T2504).
 */
export function quietPriorityOf(quietHours: QuietHours | undefined): number {
  return quietHours?.action === 'block' ? HELD_PRIORITY : QUIET_PRIORITY;
}

/** True for a status whose task names reasons to wait for: it goes on once they all cleared (`check`'s READY). */
function goesOnByWaits(status: TaskStatus): boolean {
  return status === 'waiting' || status === 'verifying';
}

/**
 * True when the task's owner can go on with it now: an open or in-progress task, or a waiting task (a verifying
 * task's proof waits) whose every reason cleared or was answered ({@link waitsLetGoOn}). A task never started also
 * waits for every task it comes after to finish: `after` gates its start, so a task already started is past it. A
 * finished task, or one waiting on a decision or an approval not yet answered, never.
 */
export function canGoOn(task: Task, context: WaitContext): boolean {
  if (task.status === 'done' || task.status === 'dropped') {
    return false;
  }
  if (goesOnByWaits(task.status) && !waitsLetGoOn(task, context)) {
    return false;
  }
  return task.startedAt !== null || unfinishedAfter(task.after, context).length === 0;
}

/** What a wake judges a task by: its waits, and whether the park rule took it. */
export interface WakeContext extends WaitContext {
  isParked(task: Task): boolean;
}

/**
 * The context of a wake's read at `now`. Which tasks are needed is built on the first task that reaches that test of
 * the rule, as most never do. A wake's `elsewhere` comes from `snapshotWithElsewhere`, which gives none when the own
 * tasks need no outside id, so a need from another register goes unseen: a wake may pass over a task `list` still shows.
 */
export function wakeContext(tasks: ReadonlyMap<string, Task>, elsewhere: TasksElsewhere, now: number, zone: TimeZone, parking: ParkRules): WakeContext {
  let needed: ReadonlySet<string> | undefined;
  const isNeeded = (id: string): boolean => {
    needed ??= neededIds(tasks.values(), elsewhere);
    return needed.has(id);
  };
  return { ...waitContext(tasks, new Date(now), zone, elsewhere), isParked: (task) => wouldPark(task, { ...parking, now, needed: isNeeded }) };
}

/** True when the task is the session's, it can go on with it now, it is urgent enough to wake it, and it is not parked. */
export function isWakeWorthy(task: Task, session: string, maxPriority: number, context: WakeContext): boolean {
  return task.owner === session && task.priority <= maxPriority && canGoOn(task, context) && !context.isParked(task);
}

function timeOf(at: string | null): number {
  return at === null ? Number.NEGATIVE_INFINITY : Date.parse(at);
}

/**
 * True when a session other than `session` finished the task after `seen`, epoch ms. A task another register of the
 * team tree holds (`elsewhere`) is news whoever finished it, since session ids repeat across teams; the read wins an
 * id both hold.
 */
function finishedByAnotherSince(id: string, session: string, tasks: ReadonlyMap<string, Task>, elsewhere: TasksElsewhere, seen: number): boolean {
  const task = tasks.get(id);
  if (task !== undefined) {
    return task.updatedBy !== session && timeOf(task.statusAt) > seen;
  }
  const other = elsewhere.get(id)?.task;
  return other !== undefined && timeOf(other.statusAt) > seen;
}

/**
 * True when someone else changed the task since its owner last touched it: handed it over, raised its priority,
 * set its status, finished a task it comes after or waits on, answered an approval it waits on, or recorded the
 * owner's decision on its card (T1366); or when a time it waits for falls after that touch (the caller asks only once
 * the task can go on, so that time has come). The owner's own changes are never news to it. A task it comes after or
 * waits on may be another register's of the team tree (`elsewhere`).
 */
export function isNews(task: Task, session: string, tasks: ReadonlyMap<string, Task>, elsewhere: TasksElsewhere, zone: TimeZone): boolean {
  const seen = timeOf(task.ownerSeenAt);
  if (Math.max(timeOf(task.assignedAt), timeOf(task.priorityAt), timeOf(task.statusAt)) > seen) {
    return true;
  }
  if (task.decided !== null && task.decided.by !== session && timeOf(task.decided.at) > seen) {
    return true;
  }
  if (task.after.some((id) => finishedByAnotherSince(id, session, tasks, elsewhere, seen))) {
    return true;
  }
  return task.waits.some((reason) => {
    switch (reason.kind) {
      case 'task':
        return finishedByAnotherSince(reason.id, session, tasks, elsewhere, seen);
      case 'time':
        return (parseDeadline(reason.at, zone)?.getTime() ?? Number.NEGATIVE_INFINITY) > seen;
      case 'approval': {
        const answer = answerTo(task, reason);
        return answer !== undefined && answer.by !== session && timeOf(answer.at) > seen;
      }
      case 'decision':
        return false;
    }
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
  /** The tasks the team tree's other registers hold, which a wait or an `after` may name. */
  readonly elsewhere: TasksElsewhere;
  readonly session: string;
  readonly tab: string;
  readonly now: number;
  /** The team's zone, which a waiting task's stored day is a day of. */
  readonly zone: TimeZone;
  readonly maxPriority: number;
  readonly parking: ParkRules;
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

/** What picks the tasks that could wake a session at a moment. */
export type WorthyInput = Pick<WakeInput, 'tasks' | 'elsewhere' | 'session' | 'now' | 'zone' | 'maxPriority' | 'parking'>;

/** The session's tasks that could wake it at `now` ({@link isWakeWorthy}), in the register's order. */
export function worthyTasksOf(input: WorthyInput): Task[] {
  const context = wakeContext(input.tasks, input.elsewhere, input.now, input.zone, input.parking);
  return [...input.tasks.values()].filter((task) => isWakeWorthy(task, input.session, input.maxPriority, context));
}

/** A tab teamrig opened on a Claude Code session the session ran in before, and the session's last wake state. */
export interface OpenedTab extends WorthyInput {
  readonly tab: string;
  readonly previous: WakeState | undefined;
}

/**
 * The wake state of a tab teamrig opened on a Claude Code session it resumed: its first prompt has the session read
 * its list, so the open counts as its wake. What could wake it now is known, so only work handed after the open wakes
 * it, and the open is its last wake for `wake.minGapMinutes`. A resumed tab keeps the id it had before its close, so
 * without this the check went on from the state before the close and woke it again for the work it reads (T1616).
 */
export function openedWakeState(opened: OpenedTab): WakeState {
  const known = worthyTasksOf(opened).map((task) => task.id);
  return { tab: opened.tab, known, pending: undefined, lastWakeAt: opened.now, settled: opened.previous?.settled ?? NO_SETTLED_MOMENTS };
}

/**
 * Whether to wake the session now, later or not, and the state to keep. A first check in a tab takes what is
 * there as known: work from before the tab started is seen at its first prompt, as it always was.
 */
export function decideWake(input: WakeInput): WakeDecision {
  const { tasks, elsewhere, session, tab, now, previous } = input;
  const worthy = worthyTasksOf(input);
  const known = worthy.map((task) => task.id);
  const none: WakeVerdict = { kind: 'none' };
  const settled = previous?.settled ?? NO_SETTLED_MOMENTS;
  if (previous?.tab !== tab) {
    return { verdict: none, state: { tab, known, pending: undefined, lastWakeAt: previous?.lastWakeAt, settled } };
  }
  const wasKnown = new Set(previous.known);
  const pendingIds = new Set(previous.pending?.ids ?? []);
  const kept = worthy.filter((task) => pendingIds.has(task.id) && isNews(task, session, tasks, elsewhere, input.zone));
  const fresh = worthy.filter((task) => !wasKnown.has(task.id) && isNews(task, session, tasks, elsewhere, input.zone));
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

/**
 * Whether the session should rest: held by its budget (`isHeld`) or paused by a short day ({@link isPausedNow}), so
 * woken, reopened and sent back to work for p0 alone; or in the budget's quiet hours.
 */
export interface WakeRest {
  readonly held: boolean;
  readonly quiet: boolean;
}

/**
 * True when a short day funds none of the session's work (`BudgetFacts.paused`, src/budget/pause.ts) and no burst
 * holds its budget up: it rests whatever room the team has left today, or the wakes, the idle pass and the stop hook's
 * keep-working ask hand it the work the pause stopped (T1598).
 */
function isPausedNow(facts: BudgetFacts): boolean {
  return facts.paused && facts.burst === undefined;
}

/**
 * Where the session stands against its budget at `now`: held (past its daily budget, its lift's while lifted, while
 * the team has no room today or a leader's cut holds it, or paused: {@link isPausedNow}), and in quiet hours unless
 * its lift exempts it. The turn a wake would start counts as spent (`turnW`, in W), so a session with less left than
 * that turn is held before it, not after (T1322). With no facts (the week's use is not known yet) it is never held,
 * and quiet hours go by the clock alone.
 */
export function wakeRestOf(facts: BudgetFacts | undefined, quietHours: QuietHours | undefined, now: number, turnW: number): WakeRest {
  if (facts === undefined) {
    return { held: false, quiet: quietSpanOf(quietHours, now) !== undefined };
  }
  const turnPct = facts.todayWPerPct > 0 ? turnW / facts.todayWPerPct : 0;
  return { held: isPausedNow(facts) || isHeld(facts, turnPct), quiet: sessionQuietSpan(facts, quietHours) !== undefined };
}

/**
 * The least urgent priority that wakes the session now: p0 only while its budget holds or pauses it, in quiet hours
 * the cap `quietHours` sets ({@link quietPriorityOf}).
 */
export function effectivePriority(configured: number, rest: WakeRest, quietHours: QuietHours | undefined): number {
  if (rest.held) {
    return Math.min(configured, HELD_PRIORITY);
  }
  return rest.quiet ? Math.min(configured, quietPriorityOf(quietHours)) : configured;
}

/** What a wake costs. */
export interface WakeCost {
  readonly w: number;
  readonly cold: boolean;
  /** In % of the week, at today's W per percent; undefined while that is unknown. */
  readonly weekPct: number | undefined;
  /**
   * How many past notification turns `w` is the average of; absent when there were too few, and `w` is then only the
   * first call's W (a floor: the turn's follow-on calls cost more, which the average counts).
   */
  readonly measuredTurns?: number;
}

/**
 * The cost of waking a session idle `idleMs` (undefined: unknown, counted cold). It is cold past
 * `messages.coldAfterMinutes`; a team that set that to 0 (no held sends) still has a cache that expires, so the
 * default applies then. `wPerPct` is today's W per percent of the week (`readTodayWPerPct`, cli/stored-week.ts), as
 * `teamrig budget` prices today's rows, undefined while unknown.
 */
export function wakeCost(idleMs: number | undefined, coldAfterMinutes: number, wPerPct: number | undefined, measured: MeasuredTurns | undefined): WakeCost {
  const after = coldAfterMinutes > 0 ? coldAfterMinutes : DEFAULT_MESSAGES.coldAfterMinutes;
  const cold = idleMs === undefined || isCold(idleMs, after);
  // The first call alone is 27k or 210k W, but the turn's follow-on calls dominate (~340k measured), so a measured
  // average of past notification turns replaces it once there is enough of it.
  const w = measured?.w ?? (cold ? COLD_WAKE_W : WARM_WAKE_W);
  return { w, cold, weekPct: wPerPct === undefined || wPerPct <= 0 ? undefined : w / wPerPct, ...(measured === undefined ? {} : { measuredTurns: measured.turns }) };
}

/** The smallest share of the week `formatPct` shows as more than 0.00%. */
const LEAST_PCT = 0.01;

/** `, under 0.01% of the week` or `, 0.05% of the week`; empty while the week's W per percent is unknown. */
export function weekShareText(weekPct: number | undefined): string {
  return weekPct === undefined ? '' : weekPct < LEAST_PCT ? `, under ${formatPct(LEAST_PCT)} of the week` : `, ${formatPct(weekPct)} of the week`;
}

/**
 * `about 340k W, the average of 121 notification turns in the last 7 days, 0.2% of the week`, or with too little
 * history `at least about 27k W for the first call, warm cache; whole turns usually cost more`.
 */
export function costText(cost: WakeCost): string {
  if (cost.measuredTurns !== undefined) {
    return `about ${formatW(cost.w)} W, the average of ${cost.measuredTurns} notification turns in the last ${MEASURED_DAYS} days${weekShareText(cost.weekPct)}`;
  }
  return `at least about ${formatW(cost.w)} W for the first call, ${cost.cold ? 'cold' : 'warm cache'}${weekShareText(cost.weekPct)}; whole turns usually cost more`;
}

function shortTitle(title: string): string {
  return title.length <= WAKE_TITLE_MAX ? title : `${title.slice(0, WAKE_TITLE_MAX - 3)}...`;
}

/** `T12 "Fix the login" (p1), T13 "..." (p1) and 2 more`. */
export function taskListText(tasks: readonly Task[]): string {
  const named = tasks.slice(0, WAKE_LIST_MAX).map((task) => `${task.id} "${shortTitle(task.title)}" (${taskTag(task)})`);
  const more = tasks.length - named.length;
  return more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ');
}

/**
 * `p2`, or for a task that goes on by its waits, so the session sets its next status: `p2, waiting: lead recorded the
 * owner's decision` once a leader recorded one (T1366), `p2, waiting: lead approved it` (or declined it) once an
 * approval it waits on was answered, else `p2, waiting: every wait cleared`.
 */
function taskTag(task: Task): string {
  if (!goesOnByWaits(task.status)) {
    return `p${task.priority}`;
  }
  if (task.decided !== null) {
    return `p${task.priority}, ${task.status}: ${task.decided.by} recorded the owner's decision`;
  }
  const answer = task.waits.map((reason) => answerTo(task, reason)).find((found) => found !== undefined);
  return `p${task.priority}, ${task.status}: ${answer === undefined ? 'every wait cleared' : `${answer.by} ${answer.verdict} it`}`;
}

/** The prompt the session reads, under the plugin's name. */
export function wakePrompt(session: string, tasks: readonly Task[], cost: WakeCost): string {
  return (
    `New work was handed to you while this tab was idle: ${taskListText(tasks)}. ` +
    `Start a work block (\`${KIT_NAME} start --session ${session}\`) and work your list in plan order. ` +
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
