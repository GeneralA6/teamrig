import { MS_PER_DAY } from "../core/time.js";
/**
 * Does the team's plan move every day? A goal or a week tag ties a task to the plan; a planned task moved when its
 * owner wrote on it (started, noted, set waiting, shipped or closed it) since the start of the day `days` days back.
 * When none did, while the week has usage left, NO-PROGRESS names the first planned task in plan order that its
 * owner can move now and that the first day of that span already held: a plan made today has had no day to move.
 */
/** A planned task its owner wrote on in one of these statuses moved: work on it was started, handed on or finished. */
const MOVED_STATUSES = ['in-progress', 'waiting', 'verifying', 'done'];
/** Planned work its owner can move now: not waiting on something else, not shipped. */
const MOVABLE_STATUSES = ['open', 'in-progress'];
function isPlanned(task) {
    return task.goals.length > 0 || task.week !== null;
}
/** NO-PROGRESS for one register, or undefined when its plan moved, it is off, or the week's usage is spent. */
export function noProgressFlag({ tasks, tree, dayStart, days, leftPct }) {
    if (days === 0 || leftPct === 0) {
        return undefined;
    }
    const since = dayStart - days * MS_PER_DAY;
    const planned = [...tasks].filter(isPlanned);
    if (planned.some((task) => movedSince(task, since))) {
        return undefined;
    }
    const [first] = planned
        .filter((task) => MOVABLE_STATUSES.includes(task.status) && Date.parse(task.createdAt) < since + MS_PER_DAY)
        .sort((a, b) => tree.byPlanOrder(a, b));
    if (first === undefined) {
        return undefined;
    }
    const span = days === 1 ? '1 day' : `${days} days`;
    return { kind: 'NO-PROGRESS', task: first, detail: `no goal or week-plan task moved since ${tree.zone.shortMinute(new Date(since))} (${span}); the first to move` };
}
function movedSince(task, since) {
    return MOVED_STATUSES.includes(task.status) && task.ownerSeenAt !== null && Date.parse(task.ownerSeenAt) >= since;
}
