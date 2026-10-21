import { formatPct, formatW } from "../budget/format.js";
import { isHeld, quietSpanOf, sessionQuietSpan } from "../budget/warn.js";
import { DEFAULT_MESSAGES } from "../config/defaults.js";
import { KIT_NAME } from "../core/home.js";
import { parseDeadline } from "../core/time.js";
import { isCold } from "../hooks/cold-send.js";
import { taskNumber } from "../register/fold.js";
import { allReady, unfinishedAfter, waitContext } from "../register/waits.js";
/**
 * Waking a session idle at its prompt when work is handed to it, pure. A wake is a model turn, so only work the
 * session can go on with now ({@link canGoOn}) and has not seen wakes it: its own task at `wake.priority` or more
 * urgent, changed by someone else or by the clock since the session last touched it (handed to it, raised,
 * reopened, freed by another's finish, or its waits cleared). Each task wakes a session once, tasks handed together
 * wake it once (`wake.batchSeconds`), and wakes of one session are `wake.minGapMinutes` apart. The plugin's mod asks
 * `hook wake-check` while no turn runs and submits the prompt.
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
/** The most urgent priority: what a session past its budget or in quiet hours still wakes for. */
export const URGENT_PRIORITY = 1;
/** True for a status whose task names reasons to wait for: it goes on once they all cleared (`check`'s READY). */
function goesOnByWaits(status) {
    return status === 'waiting' || status === 'verifying';
}
/**
 * True when the task's owner can go on with it now: an open or in-progress task, or a waiting task (a verifying
 * task's proof waits) whose every reason cleared, as `check` flags READY. A task never started also waits for every
 * task it comes after to finish: `after` gates its start, so a task already started is past it. A finished task, or
 * one waiting on a decision or an approval, never.
 */
export function canGoOn(task, context) {
    if (task.status === 'done' || task.status === 'dropped') {
        return false;
    }
    if (goesOnByWaits(task.status) && !allReady(task.waits, context)) {
        return false;
    }
    return task.startedAt !== null || unfinishedAfter(task.after, context).length === 0;
}
/** True when the task is the session's, it can go on with it now, and it is urgent enough to wake it. */
export function isWakeWorthy(task, session, maxPriority, context) {
    return task.owner === session && task.priority <= maxPriority && canGoOn(task, context);
}
function timeOf(at) {
    return at === null ? Number.NEGATIVE_INFINITY : Date.parse(at);
}
/** True when a session other than `session` finished the task after `seen`, epoch ms. */
function finishedByAnotherSince(id, session, tasks, seen) {
    const task = tasks.get(id);
    return task !== undefined && task.updatedBy !== session && timeOf(task.statusAt) > seen;
}
/**
 * True when someone else changed the task since its owner last touched it: handed it over, raised its priority,
 * set its status, or finished a task it comes after or waits on; or when a time it waits for falls after that touch
 * (the caller asks only once the task can go on, so that time has come). The owner's own changes are never news to it.
 */
export function isNews(task, session, tasks, zone) {
    const seen = timeOf(task.ownerSeenAt);
    if (Math.max(timeOf(task.assignedAt), timeOf(task.priorityAt), timeOf(task.statusAt)) > seen) {
        return true;
    }
    if (task.after.some((id) => finishedByAnotherSince(id, session, tasks, seen))) {
        return true;
    }
    return task.waits.some((reason) => {
        switch (reason.kind) {
            case 'task':
                return finishedByAnotherSince(reason.id, session, tasks, seen);
            case 'time':
                return (parseDeadline(reason.at, zone)?.getTime() ?? Number.NEGATIVE_INFINITY) > seen;
            case 'decision':
            case 'approval':
                return false;
        }
    });
}
export const NO_SETTLED_MOMENTS = { dayStart: undefined, burst: undefined };
/** Most urgent first, then oldest. */
export function byUrgency(a, b) {
    return a.priority - b.priority || taskNumber(a.id) - taskNumber(b.id);
}
/**
 * Whether to wake the session now, later or not, and the state to keep. A first check in a tab takes what is
 * there as known: work from before the tab started is seen at its first prompt, as it always was.
 */
export function decideWake(input) {
    const { tasks, session, tab, now, previous } = input;
    const context = waitContext(tasks, new Date(now), input.zone);
    const worthy = [...tasks.values()].filter((task) => isWakeWorthy(task, session, input.maxPriority, context));
    const known = worthy.map((task) => task.id);
    const none = { kind: 'none' };
    const settled = previous?.settled ?? NO_SETTLED_MOMENTS;
    if (previous?.tab !== tab) {
        return { verdict: none, state: { tab, known, pending: undefined, lastWakeAt: previous?.lastWakeAt, settled } };
    }
    const wasKnown = new Set(previous.known);
    const pendingIds = new Set(previous.pending?.ids ?? []);
    const kept = worthy.filter((task) => pendingIds.has(task.id) && isNews(task, session, tasks, input.zone));
    const fresh = worthy.filter((task) => !wasKnown.has(task.id) && isNews(task, session, tasks, input.zone));
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
 * Where the session stands against its budget at `now`: held (past its daily budget, its lift's while lifted, while
 * the team has no room today), and in quiet hours unless its lift exempts it. With no facts (the week's use is not
 * known yet) it is never held, and quiet hours go by the clock alone.
 */
export function wakeRestOf(facts, quietHours, now) {
    if (facts === undefined) {
        return { held: false, quiet: quietSpanOf(quietHours, now) !== undefined };
    }
    return { held: isHeld(facts), quiet: sessionQuietSpan(facts, quietHours) !== undefined };
}
/** The least urgent priority that wakes the session now: p1 only while its budget holds it or in quiet hours. */
export function effectivePriority(configured, rest) {
    return rest.held || rest.quiet ? Math.min(configured, URGENT_PRIORITY) : configured;
}
/**
 * The cost of waking a session idle `idleMs` (undefined: unknown, counted cold). It is cold past
 * `messages.coldAfterMinutes`; a team that set that to 0 (no held sends) still has a cache that expires, so the
 * default applies then. `wPerPct` is the week's W per percent (`readWPerPct`, cli/stored-week.ts), undefined while unknown.
 */
export function wakeCost(idleMs, coldAfterMinutes, wPerPct) {
    const after = coldAfterMinutes > 0 ? coldAfterMinutes : DEFAULT_MESSAGES.coldAfterMinutes;
    const cold = idleMs === undefined || isCold(idleMs, after);
    const w = cold ? COLD_WAKE_W : WARM_WAKE_W;
    return { w, cold, weekPct: wPerPct === undefined || wPerPct <= 0 ? undefined : w / wPerPct };
}
/** The smallest share of the week `formatPct` shows as more than 0.00%. */
const LEAST_PCT = 0.01;
/** `about 27k W, warm cache, under 0.01% of the week`. */
export function costText(cost) {
    const week = cost.weekPct === undefined ? '' : cost.weekPct < LEAST_PCT ? `, under ${formatPct(LEAST_PCT)} of the week` : `, ${formatPct(cost.weekPct)} of the week`;
    return `about ${formatW(cost.w)} W, ${cost.cold ? 'cold' : 'warm cache'}${week}`;
}
function shortTitle(title) {
    return title.length <= WAKE_TITLE_MAX ? title : `${title.slice(0, WAKE_TITLE_MAX - 3)}...`;
}
/** `T12 "Fix the login" (p1), T13 "..." (p1) and 2 more`. */
export function taskListText(tasks) {
    const named = tasks.slice(0, WAKE_LIST_MAX).map((task) => `${task.id} "${shortTitle(task.title)}" (${taskTag(task)})`);
    const more = tasks.length - named.length;
    return more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ');
}
/** `p2`, or `p2, waiting: every wait cleared` for a task that goes on by its waits, so the session sets its next status. */
function taskTag(task) {
    return goesOnByWaits(task.status) ? `p${task.priority}, ${task.status}: every wait cleared` : `p${task.priority}`;
}
/** The prompt the session reads, under the plugin's name. */
export function wakePrompt(session, tasks, cost) {
    return (`New work was handed to you while this tab was idle: ${taskListText(tasks)}. ` +
        `Start a work block (\`${KIT_NAME} start --session ${session}\`) and work your list in priority order. ` +
        `This wake costs ${costText(cost)}.`);
}
/** `T12, T13 and 2 more`. */
export function idsText(tasks) {
    const named = tasks.slice(0, WAKE_LIST_MAX).map((task) => task.id);
    const more = tasks.length - named.length;
    return more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ');
}
/** The person's toast: which tasks woke the tab and what it costs. */
export function wakeToast(tasks, cost) {
    return `${KIT_NAME} woke this tab for ${idsText(tasks)} (${costText(cost)})`;
}
