import { MS_PER_DAY, MS_PER_HOUR, parseDayStart, showStored } from "../core/time.js";
import { NOW_PRIORITY, topPriority } from "../config/priorities.js";
import { approvalCleared, waitAnswerersOf } from "./approval.js";
import { CARD_FLAGS, GATE_FLAG, whyAskUsage } from "./card.js";
import { taskNumber } from "./fold.js";
import { leaderHolds, waitedMinutes } from "./leader-wait.js";
import { ACTIVE_STATUSES, priorityText } from "./model.js";
import { isUngated } from "./owner-waits.js";
import { loopFix, NO_TASKS_ELSEWHERE, pathText, TaskTree } from "./tree.js";
import { WATCH_USAGE } from "./verify.js";
import { formatTask } from "./views.js";
import { allReady, isPeerWait, isReady, unfinishedAfter, waitSpelling } from "./waits.js";
/** In report order: the most urgent first. */
export const FLAG_KINDS = [
    'URGENT',
    'OVERDUE',
    'VERIFY-OVERDUE',
    'LOOP',
    'VERIFY-BLOCKS',
    'READY',
    'ROADMAP-WAITS-ON-LEAD',
    'NO-REASON',
    'PEER-WAIT',
    'NO-CARD',
    'OWNER-ORDERED',
    'UNGATED',
    'NOT-PICKED-UP',
    'PRIORITY-SKIP',
    'SELF-MADE',
    'PILE-UP',
    'REPARKED',
    'OVER-PACE',
    'OVER-LIMIT',
    'OVER-SIZE',
    'OWNER-UNPLANNED',
    'DUE-UNPLANNED',
    'OFF-GOAL',
    'NO-PROGRESS',
    'STOPGAP-DONE',
    'STALE',
];
/**
 * The days OVER-PACE counts an owner's finished top tasks over. At most RETAIN_DAYS (src/register/compaction.ts): the
 * check reads the working set, and a compaction retires finished tasks older than that from it.
 */
export const PACE_DAYS = 7;
/** OVER-PACE's held work: a top task neither finished nor shipped. */
const HELD_STATUSES = ['open', 'in-progress', 'waiting'];
/** OVER-PACE's pace: a top task finished, or shipped and waiting for its proof. */
const FINISHED_STATUSES = ['done', 'verifying'];
/** OVER-PACE's least pace: an owner always has its first held top task in hand, so one is never too many. */
const IN_HAND = 1;
/**
 * The daily flags over active tasks:
 * - URGENT: open at p0 (teamrig's own level, NOW_PRIORITY) and free to start (every task it comes after finished):
 *   its owner starts it now, ahead of the task in hand; with an effective due, the detail names the lead's deadline
 *   burst that may pay for finishing it by then;
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
 *   reason its proof waited for is ready, so the proof should exist: its owner verifies it now; or decided (a leader
 *   recorded the owner's answer to its card, `update --decided`, T1366) with every wait left ready, none counting:
 *   its owner acts on the decision;
 * - NO-REASON: waiting with no reason and not decided, as a line from an older teamrig reads: nothing says what it
 *   waits for;
 * - NO-CARD: waiting on the owner's decision or approval with no card to decide from (card.ts), as one set before
 *   cards, or while `requireDecisionCard` was off, reads; never with that switch off;
 * - OWNER-ORDERED: a task the owner ordered (its source is `ownerSource`) waiting, or its proof waiting, on the
 *   owner's decision or approval with no card saying why the owner is asked (`whyAsk`, card.ts): an owner's order
 *   approves its own work and proof unless the order must change, the work needs something new, or only the owner
 *   can see the result (T802);
 * - UNGATED: waiting, or its proof waiting, on the owner's decision with a card naming no owner gate or business
 *   decision (`gate`, card.ts), as one set before gates reads; never with `requireDecisionCard` off: only an owner
 *   gate or a business decision is the owner's to decide, any other question its session's or its leader's (T1194);
 * - NOT-PICKED-UP: assigned longer ago than `notPickedUpAfterHours` with no event from its owner since
 *   (an idle session never reads its inbox, so it needs a direct wake);
 * - PRIORITY-SKIP: in progress below an open task of the same owner that outranks it (a better band, or a higher score
 *   in the same band; a tie skips nothing) and is free to start (every task it comes after finished), for longer than
 *   `prioritySkipAfterHours`: the session is not working its list in order. Rank comes from `ranking`, so a read with
 *   none raises no such flag;
 * - SELF-MADE: the first task still active past `maxSelfMadePerDay` of the tasks its owner added for itself (created
 *   by it, asked by no one else) in the 24 h before now (0 turns it off): a session adding its own work faster than
 *   anything asked for it may be looping or drifting from its goal;
 * - PILE-UP: the oldest verifying task of an owner holding more than `maxVerifying` of them (0 turns it off): shipped
 *   changes pile up unproven;
 * - REPARKED: a verifying task whose proof was put off to other waits `maxReparks` times in a row (0 turns it off):
 *   `set` refuses another, so its owner runs the proof or reopens it;
 * - OVER-PACE: an owner's held tasks of the top priority (open, in progress or waiting), in plan order, past the count
 *   of top tasks it finished (done or verifying) in the PACE_DAYS before now, and past the first, which is in hand at
 *   any pace, on the first held task past that pace:
 *   it holds more top work than it gets through, so the top priority no longer says what comes first. Not before
 *   the owner has held tasks for PACE_DAYS, so a new session has a pace to read;
 * - STALE: no event for `staleAfterHours` (not raised on top of NOT-PICKED-UP, nor for a verifying task with an
 *   effective due date: it waits quietly for its proof, and the date raises the alarm, nor for a waiting task with a
 *   time still to come: it is parked until then);
 * - OWNER-UNPLANNED: an owner order outside the current week plan;
 * - DUE-UNPLANNED: effectively due inside the current week but outside its plan;
 * - OFF-GOAL: in progress with no goal and outside the current week plan, so nothing the team planned asked
 *   for it. The register has no parent tasks: a goal tag or the week plan is what ties a task to the plan.
 * The three week flags need a week; null skips them, and each task gets at most one of them. A wait on or a plan
 * dependency after a task of another register of the team tree reads that task in `elsewhere`.
 */
export function checkTasks(tasks, now, zone, week, config, elsewhere = NO_TASKS_ELSEWHERE, ranking) {
    const at = now.getTime();
    const all = [...tasks];
    const tree = new TaskTree(new Map(all.map((task) => [task.id, task])), now, zone, week, elsewhere, ranking);
    const active = tree.inPlanOrder(all.filter((candidate) => ACTIVE_STATUSES.includes(candidate.status)));
    const plan = weekPlan(week, config.check.weekLengthDays, zone);
    const top = topPriority(config.priorities);
    const best = bestOpenTasks(active, tree);
    const piles = pileUps(active, config.maxVerifying);
    const paces = top === undefined ? new Map() : overPaces(all, active, top, at);
    const runs = selfMadeRuns(all, at, config.check.maxSelfMadePerDay);
    const flags = active.flatMap((task) => [
        ...urgentFlags(task, tree),
        ...verifyFlags(task, tree, piles, config.maxVerifying),
        ...reparkedFlags(task, config.maxReparks),
        ...selfMadeFlags(task, runs, config.check.maxSelfMadePerDay),
        ...overPaceFlags(task, paces),
        ...readyFlags(task, tree.context, config.ownerSource),
        ...(task.status === 'waiting' && task.waits.length === 0 && task.decided === null ? [{ kind: 'NO-REASON', task, detail: 'set what it waits for (--waits) or its next status' }] : []),
        ...noCardFlags(task, config),
        ...ownerOrderedFlags(task, config.ownerSource),
        ...ungatedFlags(task, config),
        ...timeFlags(task, at, config.check, tree),
        ...prioritySkip(task, best, tree, at, config.check),
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
 * PEER-WAIT: waiting (or a verifying task's proof waiting) on a decision or an approval of a peer (anyone but the
 * task owner's leaders and the owner), as a line from an older teamrig reads: a peer's work is a task, waited on by its id, which
 * clears by itself once that task finishes. Apart from {@link checkTasks}, whose register config does not name the lead.
 */
export function peerWaitFlags(tasks, tree, roles, ownerSource) {
    return [...tasks].flatMap((task) => {
        const answerers = waitAnswerersOf(tree, roles, task.owner);
        const peer = task.waits.find((reason) => isPeerWait(reason, answerers, ownerSource));
        return peer === undefined
            ? []
            : [{ kind: 'PEER-WAIT', task, detail: `${waitSpelling(peer)} is a peer's work: wait on it by its task (set ${task.id} --status waiting --ask ${peer.who} --text "<the work>")` }];
    });
}
/**
 * ROADMAP-WAITS-ON-LEAD: Roadmap work held on a leader's answer past `focus.leaderWaitMinutes` ({@link leaderHolds}), in
 * the order of `tasks`: the work the team ranked highest stands still until the leader answers, so the leader answers it
 * first. Apart from {@link checkTasks}, whose register config names neither the lead nor the focus.
 */
export function leaderWaitFlags(tasks, tree, focus, at) {
    return [...tasks].flatMap((task) => {
        const holds = leaderHolds(task, tree.approversOf(task.owner), focus, at);
        return holds.length === 0
            ? []
            : [{ kind: 'ROADMAP-WAITS-ON-LEAD', task, detail: `${holds.map(waitSpelling).join(', ')} unanswered for ${waitedMinutes(task, at)} min, past the ${focus.leaderWaitMinutes} min limit: answer it first` }];
    });
}
function weekPlan(week, lengthDays, zone) {
    const start = week === null ? undefined : parseDayStart(week, zone)?.getTime();
    return week === null || start === undefined ? undefined : { week, start, end: start + lengthDays * MS_PER_DAY };
}
/** NO-CARD, as {@link checkTasks} describes it. */
function noCardFlags(task, config) {
    const { ownerSource } = config;
    const asksOwner = task.waits.some((reason) => (reason.kind === 'decision' || reason.kind === 'approval') && reason.who === ownerSource);
    return config.requireDecisionCard && task.card === null && asksOwner
        ? [{ kind: 'NO-CARD', task, detail: `no card for ${ownerSource} to decide from: set it ${task.status} again with ${CARD_FLAGS}` }]
        : [];
}
/** OWNER-ORDERED, as {@link checkTasks} describes it. */
function ownerOrderedFlags(task, ownerSource) {
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
/** UNGATED, as {@link checkTasks} describes it. */
function ungatedFlags(task, config) {
    const { ownerSource } = config;
    return config.requireDecisionCard && isUngated(task, ownerSource)
        ? [
            {
                kind: 'UNGATED',
                task,
                detail: `only an owner gate or a business decision is ${ownerSource}'s to decide: set it ${task.status} again with ${GATE_FLAG} "<the owner gate, or business>", or decide it, or wait on your leader`,
            },
        ]
        : [];
}
/**
 * READY, as {@link checkTasks} describes it: a decided task whose waits left are ready (T1366); a waiting task's
 * reasons, or a verifying task's proof waits, all cleared; or a waiting task whose approval wait the one it waits on
 * answered yes (`approve`, T684).
 */
function readyFlags(task, context, ownerSource) {
    if (task.decided !== null && task.waits.every((reason) => isReady(reason, context))) {
        const next = task.status === 'verifying' ? 'verify it now' : 'then set its next status';
        return [{ kind: 'READY', task, detail: `${task.decided.by} recorded ${ownerSource}'s decision: act on it (show ${task.id} prints it), ${next}` }];
    }
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
function waitsForTime(task, context) {
    return task.waits.some((reason) => reason.kind === 'time' && !isReady(reason, context));
}
/** OVERDUE or VERIFY-OVERDUE on the effective due, then NOT-PICKED-UP or else STALE. */
/** URGENT, with the lead's deadline burst on the effective due, typed on the team's clock, when the task has one. */
function urgentFlags(task, tree) {
    if (task.priority !== NOW_PRIORITY.id || task.status !== 'open' || unfinishedAfter(task.after, tree.context).length > 0) {
        return [];
    }
    const due = tree.effectiveDue(task.id);
    const burst = due === undefined ? '' : `; to finish it by its due, the lead may run burst start deadline --task ${task.id} --by "${tree.zone.minute(new Date(due.at))}" --stop-pct <n> --reason "<why>"`;
    return [{ kind: 'URGENT', task, detail: `p0: start it now, ahead of the task in hand${burst}` }];
}
function timeFlags(task, at, check, tree) {
    const flags = [];
    const effective = tree.effectiveDue(task.id);
    const due = effective?.at;
    const verifying = task.status === 'verifying';
    if (effective !== undefined && effective.at < at) {
        const from = effective.from === null ? '' : `, from ${effective.from}`;
        flags.push({ kind: verifying ? 'VERIFY-OVERDUE' : 'OVERDUE', task, detail: `${verifying ? 'verify by' : 'due'} ${showStored(effective.due, tree.zone)}${from}` });
    }
    if (task.ownerSeenAt === null && at - Date.parse(task.assignedAt) > check.notPickedUpAfterHours * MS_PER_HOUR) {
        flags.push({ kind: 'NOT-PICKED-UP', task, detail: `assigned ${minute(task.assignedAt, tree.zone)}, no event from ${task.owner} since` });
    }
    else if (!(verifying && due !== undefined) && !waitsForTime(task, tree.context) && at - Date.parse(task.updatedAt) > check.staleAfterHours * MS_PER_HOUR) {
        flags.push({ kind: 'STALE', task, detail: `last event ${minute(task.updatedAt, tree.zone)} by ${task.updatedBy}` });
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
function reparkedFlags(task, max) {
    if (task.status !== 'verifying' || max === 0 || task.reparks < max) {
        return [];
    }
    return [
        {
            kind: 'REPARKED',
            task,
            detail: `its proof was put off to other waits ${task.reparks} times [register.maxReparks]: run the proof now, close it done with ${WATCH_USAGE} if tests or a dry run proved it, or reopen it`,
        },
    ];
}
/**
 * OVER-PACE, as {@link checkTasks} describes it: its detail keyed by the id of each owner's first held top task past
 * its pace. `active` is in plan order, so the flag lands on the task that pace would not reach.
 */
function overPaces(all, active, top, at) {
    const since = at - PACE_DAYS * MS_PER_DAY;
    const firstAssigned = new Map();
    const finished = new Map();
    for (const task of all) {
        const assigned = Date.parse(task.assignedAt);
        firstAssigned.set(task.owner, Math.min(assigned, firstAssigned.get(task.owner) ?? assigned));
        const status = Date.parse(task.statusAt);
        if (task.priority <= top && FINISHED_STATUSES.includes(task.status) && status > since && status <= at) {
            finished.set(task.owner, (finished.get(task.owner) ?? 0) + 1);
        }
    }
    const held = new Map();
    for (const task of active.filter((candidate) => candidate.priority <= top && HELD_STATUSES.includes(candidate.status))) {
        held.set(task.owner, [...(held.get(task.owner) ?? []), task]);
    }
    const paces = new Map();
    for (const [owner, tasks] of held) {
        const pace = finished.get(owner) ?? 0;
        const past = tasks[Math.max(pace, IN_HAND)];
        const first = firstAssigned.get(owner);
        if (past !== undefined && first !== undefined && first <= since) {
            const level = priorityText(top);
            const count = `${tasks.length} unfinished ${level} tasks`;
            const against = pace === 0
                ? ` and finished no ${level} in ${PACE_DAYS} days; this is the first past the one in hand`
                : `, more than the ${pace} ${level} it finished in ${PACE_DAYS} days; this is the first past that pace`;
            paces.set(past.id, `${owner} holds ${count}${against}`);
        }
    }
    return paces;
}
function overPaceFlags(task, paces) {
    const detail = paces.get(task.id);
    return detail === undefined ? [] : [{ kind: 'OVER-PACE', task, detail }];
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
/** Ahead on band, or on score in the same band. Equals outrank neither way, so working beside one skips nothing. */
function outranks(a, b) {
    return a.band < b.band || (a.band === b.band && a.score > b.score);
}
/**
 * Per owner, the best-ranked open task free to start; of equals, the one that has stood longest, so a skip over it
 * counts from the start. A task planned after one not finished yet is not free to start, so working below it skips
 * nothing. Empty for a tree with no ranking.
 */
function bestOpenTasks(active, tree) {
    const best = new Map();
    for (const task of active) {
        const place = tree.rankedOf(task);
        const held = best.get(task.owner);
        const free = task.status === 'open' && unfinishedAfter(task.after, tree.context).length === 0;
        if (place !== undefined && free && (held === undefined || outranks(place, held.place) || (!outranks(held.place, place) && standingSince(task) < standingSince(held.task)))) {
            best.set(task.owner, { task, place });
        }
    }
    return best;
}
/** PRIORITY-SKIP, counted from when both tasks took their current owner, status and priority. */
function prioritySkip(task, best, tree, at, check) {
    const skipped = best.get(task.owner);
    const place = tree.rankedOf(task);
    if (task.status !== 'in-progress' || skipped === undefined || place === undefined || !outranks(skipped.place, place)) {
        return [];
    }
    const since = Math.max(standingSince(task), standingSince(skipped.task));
    if (at - since <= check.prioritySkipAfterHours * MS_PER_HOUR) {
        return [];
    }
    const rank = skipped.place.band === 0 ? 'expedite' : skipped.place.workClass;
    return [{ kind: 'PRIORITY-SKIP', task, detail: `${skipped.task.id} (${rank}, score ${skipped.place.score}) waits open, skipped since ${minute(since, tree.zone)}` }];
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
function minute(instant, zone) {
    return zone.shortMinute(new Date(instant));
}
