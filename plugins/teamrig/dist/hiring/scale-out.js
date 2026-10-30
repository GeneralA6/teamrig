import { formatPct } from "../budget/format.js";
import { NOW_PRIORITY } from "../config/priorities.js";
import { KIT_NAME } from "../core/home.js";
import { MS_PER_DAY, showStored } from "../core/time.js";
import { ACTIVE_STATUSES } from "../register/model.js";
import { ownerAsk } from "../config/tree.js";
/** Statuses of work under way: a task such work needs stays with its area. */
const STARTED = ['in-progress', 'waiting', 'verifying'];
/** A count past what the pace finishes by more than this rounding is behind. */
const EPSILON = 1e-9;
/** p0, and the config's `hiring.scaleOut.topPriorities` most urgent levels: p0 takes none of those places. */
function topPriorityIds(config) {
    const ids = config.register.priorities.map((priority) => priority.id).sort((a, b) => a - b);
    return new Set([NOW_PRIORITY.id, ...ids.slice(0, config.hiring.scaleOut.topPriorities)]);
}
/** The area's active tasks of the top priorities with an effective due, by that due, then in plan order. */
function datedWork(area, tasks, input) {
    const top = topPriorityIds(input.config);
    return tasks
        .filter((task) => task.owner === area && ACTIVE_STATUSES.includes(task.status) && top.has(task.priority))
        .flatMap((task) => {
        const effective = input.tree.effectiveDue(task.id);
        return effective === undefined ? [] : [{ task, at: effective.at, due: effective.due }];
    })
        .sort((a, b) => a.at - b.at || input.tree.byPlanOrder(a.task, b.task));
}
function isMovable(task, tree) {
    return task.status === 'open' && !tree.neededBy(task.id).some((needer) => STARTED.includes(needer.status));
}
/** What the pace finishes from now until `at`: none for a date passed. */
function finishesBy(pace, now, at) {
    return (pace * Math.max(0, at - now)) / MS_PER_DAY;
}
/**
 * The slice to move: walking the work by due date, while more is due by a date than the pace finishes by then, the
 * latest movable task due by that date moves out. What is still behind after every movable task moved is stuck.
 */
function sliceOf(work, pace, now, tree) {
    const moved = new Set();
    let stuck = 0;
    work.forEach((item, index) => {
        const finishes = finishesBy(pace, now, item.at);
        const late = () => index + 1 - moved.size - finishes;
        for (const candidate of work.slice(0, index + 1).reverse()) {
            if (late() <= EPSILON) {
                break;
            }
            if (!moved.has(candidate) && isMovable(candidate.task, tree)) {
                moved.add(candidate);
            }
        }
        stuck = Math.max(stuck, Math.ceil(late() - EPSILON));
    });
    return { slice: work.filter((item) => moved.has(item)), stuck };
}
/** The date the area is furthest behind on, before any task moves. */
function behindOf(work, pace, now) {
    let worst;
    work.forEach((item, index) => {
        const finishes = finishesBy(pace, now, item.at);
        if (index + 1 > finishes + EPSILON && (worst === undefined || index + 1 - finishes > worst.count - worst.finishes)) {
            worst = { due: item.due, count: index + 1, finishes };
        }
    });
    return worst;
}
function needOf(area, tasks, input) {
    const { windowDays, minDone } = input.config.hiring.scaleOut;
    const now = input.now.getTime();
    const since = now - windowDays * MS_PER_DAY;
    const done = tasks.filter((task) => task.owner === area && task.status === 'done' && Date.parse(task.statusAt) >= since).length;
    if (done < minDone) {
        return undefined;
    }
    const pace = done / windowDays;
    const work = datedWork(area, tasks, input);
    const behind = behindOf(work, pace, now);
    if (behind === undefined) {
        return undefined;
    }
    const { slice, stuck } = sliceOf(work, pace, now, input.tree);
    const last = slice.at(-1);
    return last === undefined ? undefined : { area, done, behind, slice, last, stuck };
}
function round(value) {
    return Math.round(value * 10) / 10;
}
/** A scale-out flag's detail, its dues in the team's `zone`. */
function detailOf(need, windowDays, costPct, sparePct, zone) {
    const { behind, slice, last, stuck } = need;
    const ids = slice.map((item) => item.task.id).join(' ');
    const stuckText = stuck > 0 ? `; ${stuck} more stay late: started, or needed by started work` : '';
    return (`${behind.count} due by ${showStored(behind.due, zone)}, its pace finishes ${round(behind.finishes)} by then (${need.done} done in ${windowDays} d); ` +
        `slice ${ids}, due by ${showStored(last.due, zone)}, about ${formatPct(costPct)} of the week, ${formatPct(sparePct)} spare${stuckText}`);
}
/** The days of this week the slice runs: from now to its last due or the pace end, whichever comes first; one at least. */
function sliceDays(last, now, paceEnd) {
    return Math.max(1, Math.ceil((Math.min(paceEnd, last.at) - now) / MS_PER_DAY));
}
/** The hires on the team that hold no active task and are not due to retire for a burst over. */
function idleHires(input, tasks) {
    return input.hires
        .filter((hire) => input.config.sessions.includes(hire.session) && !(hire.burst !== undefined && input.burstsOver.has(hire.burst)))
        .filter((hire) => !tasks.some((task) => task.owner === hire.session && ACTIVE_STATUSES.includes(task.status)))
        .map((hire) => hire.session);
}
function moveAction(to) {
    return `the lead moves the slice to ${to}, an idle hire (${KIT_NAME} update <id> --owner ${to}, for each)`;
}
function hireAction(config) {
    const owner = config.hiring.policy === 'owner';
    const hire = `${KIT_NAME} hire <new id> --scope "<the slice>" --reason "SCALE-OUT"${owner ? ' --approved-by "<who>"' : ''}`;
    return `the lead ${owner ? `asks ${ownerAsk(config)}, then ` : ''}hires for it (${hire}), then ${KIT_NAME} update <id> --owner <new id>, for each`;
}
/** SCALE-OUT on each area that needs one, within the spare, and the idle hires given a slice. */
export function scaleOutFlags(input) {
    const { config, hirePct } = input;
    if (config.hiring.policy === 'off') {
        return { flags: [], busy: new Set() };
    }
    const tasks = [...input.tasks];
    const hiredOnTeam = new Set(input.hires.filter((hire) => config.sessions.includes(hire.session)).map((hire) => hire.session));
    const needs = config.sessions
        .filter((area) => area !== config.roles.lead && !hiredOnTeam.has(area))
        .flatMap((area) => needOf(area, tasks, input) ?? [])
        .sort((a, b) => b.behind.count - b.behind.finishes - (a.behind.count - a.behind.finishes));
    const idle = idleHires(input, tasks);
    const busy = new Set();
    const flags = [];
    if (input.spare === undefined || hirePct === undefined) {
        return { flags: [], busy };
    }
    const { paceEnd } = input.spare;
    let spare = input.spare.sparePct;
    const now = input.now.getTime();
    for (const need of needs) {
        const costPct = hirePct * sliceDays(need.last, now, paceEnd);
        if (spare < costPct) {
            continue;
        }
        const detail = detailOf(need, config.hiring.scaleOut.windowDays, costPct, spare, input.tree.zone);
        spare -= costPct;
        const to = idle.find((session) => !busy.has(session));
        if (to !== undefined) {
            busy.add(to);
            flags.push({ kind: 'SCALE-OUT', session: need.area, detail, action: moveAction(to) });
            continue;
        }
        flags.push({ kind: 'SCALE-OUT', session: need.area, detail, action: hireAction(config) });
    }
    return { flags, busy };
}
