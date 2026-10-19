import { formatUtcMinute, MS_PER_DAY, MS_PER_HOUR, parseUtcDay, shortUtc } from "../core/time.js";
import { topPriority } from "../config/priorities.js";
import { CARD_FLAGS } from "./card.js";
import { taskNumber } from "./fold.js";
import { ACTIVE_STATUSES, priorityText } from "./model.js";
import { loopFix, pathText, TaskTree } from "./tree.js";
import { formatTask } from "./views.js";
import { allReady, isPeerWait, isReady, unfinishedAfter, waitSpelling } from "./waits.js";
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
];
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
 * - OVERDUE: past its effective deadline (its own due, or an earlier one of a task that needs it, named in the detail
 *   as `due 01-10, from T5`); VERIFY-OVERDUE when the task is verifying: that date is the date to verify it by;
 * - LOOP: the lowest-numbered task of a loop among active tasks (`T2 -> T5 -> T2`), which none of them can finish:
 *   rows an older teamrig wrote, or links set before the register refused loops; the detail names how its first
 *   link goes;
 * - VERIFY-BLOCKS: verifying, and another active task is planned after it or waits on it, so that work cannot start
 *   until the proof comes (`set` refuses its start);
 * - READY: waiting, and every reason it waits for is ready (its tasks finished, its time passed), so its owner can
 *   go on: only the owner clears a decision or an approval, by setting the next status;
 * - NO-REASON: waiting with no reason, as a line from an older teamrig reads: nothing says what it waits for;
 * - NO-CARD: waiting on the owner's decision or approval with no card to decide from (card.ts), as one set before
 *   cards, or while `requireDecisionCard` was off, reads; never with that switch off;
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
export function checkTasks(tasks, now, week, config) {
    const at = now.getTime();
    const all = [...tasks];
    const tree = new TaskTree(new Map(all.map((task) => [task.id, task])), now);
    const active = tree.inPlanOrder(all.filter((candidate) => ACTIVE_STATUSES.includes(candidate.status)));
    const plan = weekPlan(week, config.check.weekLengthDays);
    const top = topPriority(config.priorities);
    const waiting = top === undefined ? new Map() : waitingTopTasks(active, top, tree.context);
    const piles = pileUps(active, config.maxVerifying);
    const runs = selfMadeRuns(all, at, config.check.maxSelfMadePerDay);
    const flags = active.flatMap((task) => [
        ...verifyFlags(task, tree, piles, config.maxVerifying),
        ...selfMadeFlags(task, runs, config.check.maxSelfMadePerDay),
        ...(task.status === 'waiting' && allReady(task.waits, tree.context) ? [{ kind: 'READY', task, detail: 'every reason cleared; set its next status' }] : []),
        ...(task.status === 'waiting' && task.waits.length === 0 ? [{ kind: 'NO-REASON', task, detail: 'set what it waits for (--waits) or its next status' }] : []),
        ...noCardFlags(task, config),
        ...timeFlags(task, at, config.check, tree),
        ...(top === undefined ? [] : prioritySkip(task, top, waiting, at, config.check)),
        ...(plan === undefined ? [] : planFlags(task, plan, config.ownerSource, tree)),
    ]);
    return [...flags, ...loopFlags(tree)].sort(byFlagKind);
}
/** Orders flags by FLAG_KINDS, most urgent first; the sort is stable, so each kind keeps its own order. */
export function byFlagKind(a, b) {
    return FLAG_KINDS.indexOf(a.kind) - FLAG_KINDS.indexOf(b.kind);
}
/** One flag; with `team`, the task id reads `<team>/T12`; `tree` reads the task line as {@link formatTask} does. */
export function formatFlag(flag, team, tree) {
    return `${flag.kind} (${flag.detail}) ${formatTask(flag.task, team, tree)}`;
}
/**
 * PEER-WAIT: waiting on a decision or an approval of a peer (anyone but the lead and the owner), as a line from an
 * older teamrig reads: a peer's work is a task, waited on by its id, which clears by itself once that task finishes.
 * Apart from {@link checkTasks}, whose register config does not name the lead.
 */
export function peerWaitFlags(tasks, lead, ownerSource) {
    return [...tasks].flatMap((task) => {
        const peer = task.status === 'waiting' ? task.waits.find((reason) => isPeerWait(reason, lead, ownerSource)) : undefined;
        return peer === undefined
            ? []
            : [{ kind: 'PEER-WAIT', task, detail: `${waitSpelling(peer)} is a peer's work: wait on it by its task (set ${task.id} --status waiting --ask ${peer.who} --text "<the work>")` }];
    });
}
function weekPlan(week, lengthDays) {
    const start = week === null ? undefined : parseUtcDay(week)?.getTime();
    return week === null || start === undefined ? undefined : { week, start, end: start + lengthDays * MS_PER_DAY };
}
/** NO-CARD, as {@link checkTasks} describes it. */
function noCardFlags(task, config) {
    const { ownerSource } = config;
    const asksOwner = task.waits.some((reason) => (reason.kind === 'decision' || reason.kind === 'approval') && reason.who === ownerSource);
    return config.requireDecisionCard && task.status === 'waiting' && task.card === null && asksOwner
        ? [{ kind: 'NO-CARD', task, detail: `no card for ${ownerSource} to decide from: set it waiting again with ${CARD_FLAGS}` }]
        : [];
}
/** A waiting task with a time reason still to come: parked on purpose until then, so not stale. */
function waitsForTime(task, context) {
    return task.status === 'waiting' && task.waits.some((reason) => reason.kind === 'time' && !isReady(reason, context));
}
/** OVERDUE or VERIFY-OVERDUE on the effective due, then NOT-PICKED-UP or else STALE. */
function timeFlags(task, at, check, tree) {
    const flags = [];
    const effective = tree.effectiveDue(task.id);
    const due = effective?.at;
    const verifying = task.status === 'verifying';
    if (effective !== undefined && effective.at < at) {
        const from = effective.from === null ? '' : `, from ${effective.from}`;
        flags.push({ kind: verifying ? 'VERIFY-OVERDUE' : 'OVERDUE', task, detail: `${verifying ? 'verify by' : 'due'} ${shortUtc(effective.due)}${from}` });
    }
    if (task.ownerSeenAt === null && at - Date.parse(task.assignedAt) > check.notPickedUpAfterHours * MS_PER_HOUR) {
        flags.push({ kind: 'NOT-PICKED-UP', task, detail: `assigned ${minute(task.assignedAt)}, no event from ${task.owner} since` });
    }
    else if (!(verifying && due !== undefined) && !waitsForTime(task, tree.context) && at - Date.parse(task.updatedAt) > check.staleAfterHours * MS_PER_HOUR) {
        flags.push({ kind: 'STALE', task, detail: `last event ${minute(task.updatedAt)} by ${task.updatedBy}` });
    }
    return flags;
}
/**
 * LOOP, once per loop among active tasks, on its first task, with how its first link goes: by `set --ask` when that
 * task waits on the next one, else by a new task it is planned after.
 */
function loopFlags(tree) {
    return tree.loops().flatMap((loop) => {
        const [first, next] = loop;
        const task = first === undefined ? undefined : tree.task(first);
        const owner = next === undefined ? undefined : tree.task(next)?.owner;
        if (task === undefined || next === undefined || owner === undefined) {
            return [];
        }
        const fix = loopFix(task.id, next, owner, !task.after.includes(next));
        return [{ kind: 'LOOP', task, detail: `${pathText(loop)} is a loop, and no task in a loop can finish: ${fix}` }];
    });
}
/** Per owner holding more than `max` verifying tasks (0: none), its count, keyed by the id of its oldest one. */
function pileUps(active, max) {
    const byOwner = new Map();
    for (const task of active.filter((candidate) => candidate.status === 'verifying')) {
        byOwner.set(task.owner, [...(byOwner.get(task.owner) ?? []), task]);
    }
    const piles = new Map();
    for (const held of byOwner.values()) {
        const oldest = [...held].sort((a, b) => Date.parse(a.statusAt) - Date.parse(b.statusAt))[0];
        if (max > 0 && held.length > max && oldest !== undefined) {
            piles.set(oldest.id, held.length);
        }
    }
    return piles;
}
/** VERIFY-BLOCKS on a verifying task that active tasks need (planned after it or waiting on it), then PILE-UP on the oldest task of a pile. */
function verifyFlags(task, tree, piles, max) {
    const flags = [];
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
function isSelfMade(task) {
    return task.createdBy === task.owner && task.source === task.owner;
}
/**
 * Per owner that added more than `max` tasks for itself in the 24 h before `at` (0: none), its count, keyed by the id
 * of the first of them past `max` that is still active. A run whose surplus is all finished raises nothing: no work of
 * it is left to read.
 */
function selfMadeRuns(all, at, max) {
    const runs = new Map();
    if (max === 0) {
        return runs;
    }
    const byOwner = new Map();
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
function selfMadeFlags(task, runs, max) {
    const made = runs.get(task.id);
    if (made === undefined) {
        return [];
    }
    return [{ kind: 'SELF-MADE', task, detail: `${task.owner} added ${made} tasks for itself in 24 h, more than ${max}; this is the first still active past ${max}` }];
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
/** OWNER-UNPLANNED, or else DUE-UNPLANNED (on the effective due), or else OFF-GOAL. */
function planFlags(task, plan, ownerSource, tree) {
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
function minute(instant) {
    return shortUtc(formatUtcMinute(new Date(instant)));
}
