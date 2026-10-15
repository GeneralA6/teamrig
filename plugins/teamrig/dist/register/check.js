import { formatUtcMinute, MS_PER_DAY, MS_PER_HOUR, parseUtcDay, shortUtc } from "../core/time.js";
import { topPriority } from "../config/priorities.js";
import { ACTIVE_STATUSES, priorityText } from "./model.js";
import { byPlanOrder, dueTime, formatTask } from "./views.js";
import { allReady, unfinishedAfter, waitContext } from "./waits.js";
/** In report order: the most urgent first. */
export const FLAG_KINDS = ['OVERDUE', 'VERIFY-OVERDUE', 'READY', 'NOT-PICKED-UP', 'PRIORITY-SKIP', 'OWNER-UNPLANNED', 'DUE-UNPLANNED', 'OFF-GOAL', 'STALE'];
/** The week plan in force: the newest week tag that starts on or before now. */
export function currentWeek(tasks, now) {
    let best = null;
    for (const task of tasks) {
        const start = task.week === null ? undefined : parseUtcDay(task.week);
        if (task.week !== null && start !== undefined && start.getTime() <= now.getTime() && (best === null || task.week > best)) {
            best = task.week;
        }
    }
    return best;
}
/**
 * The week plan in force over a register as read: `currentWeek` of its tasks, or the newest week of
 * the tasks a compaction retired when that is newer, as a replay of the whole history would find it.
 */
export function currentWeekOf(snapshot, now) {
    const live = currentWeek(snapshot.state.tasks.values(), now);
    const retired = snapshot.retired?.lastWeek ?? null;
    const started = retired === null ? undefined : parseUtcDay(retired);
    return retired !== null && started !== undefined && started.getTime() <= now.getTime() && (live === null || retired > live) ? retired : live;
}
/**
 * The daily flags over active tasks:
 * - OVERDUE: past its deadline; VERIFY-OVERDUE when the task is verifying: its due date is the date to verify it by;
 * - READY: waiting, and every reason it waits for is ready (its tasks finished, its time passed), so its owner can
 *   go on: only the owner clears a decision or an approval, by setting the next status;
 * - NOT-PICKED-UP: assigned longer ago than `notPickedUpAfterHours` with no event from its owner since
 *   (an idle session never reads its inbox, so it needs a direct wake);
 * - PRIORITY-SKIP: in progress below an open task of the top priority that has the same owner and is free to start
 *   (every task it comes after finished), for longer than `prioritySkipAfterHours`: the session is not working its
 *   list in order;
 * - STALE: no event for `staleAfterHours` (not raised on top of NOT-PICKED-UP, nor for a verifying task with a
 *   due date: it waits quietly for its proof, and the date raises the alarm);
 * - OWNER-UNPLANNED: an owner order outside the current week plan;
 * - DUE-UNPLANNED: due inside the current week but outside its plan;
 * - OFF-GOAL: in progress with no goal and outside the current week plan, so nothing the team planned asked
 *   for it. The register has no parent tasks: a goal tag or the week plan is what ties a task to the plan.
 * The three week flags need a week; null skips them, and each task gets at most one of them.
 */
export function checkTasks(tasks, now, week, config) {
    const at = now.getTime();
    const all = [...tasks];
    const context = waitContext(new Map(all.map((task) => [task.id, task])), now);
    const active = all.filter((candidate) => ACTIVE_STATUSES.includes(candidate.status)).sort(byPlanOrder);
    const plan = weekPlan(week, config.check.weekLengthDays);
    const top = topPriority(config.priorities);
    const waiting = top === undefined ? new Map() : waitingTopTasks(active, top, context);
    const flags = active.flatMap((task) => [
        ...(task.status === 'waiting' && allReady(task.waits, context) ? [{ kind: 'READY', task, detail: 'every reason cleared; set its next status' }] : []),
        ...timeFlags(task, at, config.check),
        ...(top === undefined ? [] : prioritySkip(task, top, waiting, at, config.check)),
        ...(plan === undefined ? [] : planFlags(task, plan, config.ownerSource)),
    ]);
    return flags.sort((a, b) => FLAG_KINDS.indexOf(a.kind) - FLAG_KINDS.indexOf(b.kind));
}
/** One flag; with `team`, the task id reads `<team>/T12`; `context` marks a waiting task's ready reasons. */
export function formatFlag(flag, team, context) {
    return `${flag.kind} (${flag.detail}) ${formatTask(flag.task, team, context)}`;
}
function weekPlan(week, lengthDays) {
    const start = week === null ? undefined : parseUtcDay(week)?.getTime();
    return week === null || start === undefined ? undefined : { week, start, end: start + lengthDays * MS_PER_DAY };
}
/** OVERDUE or VERIFY-OVERDUE, then NOT-PICKED-UP or else STALE. */
function timeFlags(task, at, check) {
    const flags = [];
    const due = dueTime(task);
    const verifying = task.status === 'verifying';
    if (due !== undefined && due < at) {
        const detail = `${verifying ? 'verify by' : 'due'} ${shortUtc(task.due ?? '')}`;
        flags.push({ kind: verifying ? 'VERIFY-OVERDUE' : 'OVERDUE', task, detail });
    }
    if (task.ownerSeenAt === null && at - Date.parse(task.assignedAt) > check.notPickedUpAfterHours * MS_PER_HOUR) {
        flags.push({ kind: 'NOT-PICKED-UP', task, detail: `assigned ${minute(task.assignedAt)}, no event from ${task.owner} since` });
    }
    else if (!(verifying && due !== undefined) && at - Date.parse(task.updatedAt) > check.staleAfterHours * MS_PER_HOUR) {
        flags.push({ kind: 'STALE', task, detail: `last event ${minute(task.updatedAt)} by ${task.updatedBy}` });
    }
    return flags;
}
/** Since when the task has stood where it is in its owner's list: its latest change of owner, status or priority. */
function standingSince(task) {
    return Math.max(Date.parse(task.assignedAt), Date.parse(task.statusAt), Date.parse(task.priorityAt));
}
/**
 * Per owner, the open task of the top priority, free to start, that has stood longest, so a skip over it counts from
 * the start. A task planned after one not finished yet is not free to start, so working below it skips nothing.
 */
function waitingTopTasks(active, top, context) {
    const waiting = new Map();
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
function prioritySkip(task, top, waiting, at, check) {
    const skipped = waiting.get(task.owner);
    if (task.status !== 'in-progress' || task.priority <= top || skipped === undefined) {
        return [];
    }
    const since = Math.max(standingSince(task), standingSince(skipped));
    if (at - since <= check.prioritySkipAfterHours * MS_PER_HOUR) {
        return [];
    }
    return [{ kind: 'PRIORITY-SKIP', task, detail: `${priorityText(skipped.priority)} ${skipped.id} waits open, skipped since ${minute(since)}` }];
}
/** OWNER-UNPLANNED, or else DUE-UNPLANNED, or else OFF-GOAL. */
function planFlags(task, plan, ownerSource) {
    if (task.week === plan.week) {
        return [];
    }
    if (task.source === ownerSource) {
        return [{ kind: 'OWNER-UNPLANNED', task, detail: `owner order not in week ${plan.week}` }];
    }
    const due = dueTime(task);
    if (due !== undefined && due >= plan.start && due < plan.end) {
        return [{ kind: 'DUE-UNPLANNED', task, detail: `due inside week ${plan.week}, not in its plan` }];
    }
    if (task.status === 'in-progress' && task.goals.length === 0) {
        return [{ kind: 'OFF-GOAL', task, detail: `in progress with no goal, not in week ${plan.week}` }];
    }
    return [];
}
function minute(instant) {
    return shortUtc(formatUtcMinute(new Date(instant)));
}
