import { formatUtcDay, MS_PER_DAY } from "../core/time.js";
import { NO_GOAL } from "./goals.js";
import { ACTIVE_STATUSES } from "./model.js";
/** How far back a goal's pace looks: two weeks, so one quiet weekend does not read as a stall. */
export const GOAL_PACE_DAYS = 14;
export const GOAL_STATES = ['done', 'on track', 'at risk', 'late'];
export function goalStats(input) {
    const day = input.zone.day(input.now);
    const today = { day, ms: Date.parse(day), zone: input.zone };
    const served = tasksByGoal(input.tasks, input.goals);
    const progress = [...input.goals.values()].map((goal) => goalProgress(goal, served.get(goal.tag) ?? [], today));
    return {
        goals: input.scoped ? progress.filter((goal) => goal.tasks.length > 0) : progress,
        offGoal: input.doneInRange.filter(({ task }) => task.goals.every((tag) => tag === NO_GOAL)).length,
        doneInRange: input.doneInRange.length,
    };
}
/** Each goal's tasks: a set of tags per task, so a task with two tags under one goal counts once for it. */
function tasksByGoal(tasks, goals) {
    const byGoal = new Map();
    for (const each of tasks) {
        for (const tag of new Set(each.task.goals.flatMap((taskTag) => goalsServed(taskTag, goals)))) {
            byGoal.set(tag, [...(byGoal.get(tag) ?? []), each]);
        }
    }
    return byGoal;
}
/** The goals a task's tag serves: its deepest record, then that record's parents; the seen set stops a parent cycle. */
function goalsServed(tag, goals) {
    const seen = new Set();
    let goal = deepestGoal(tag, goals);
    while (goal !== undefined && !seen.has(goal.tag)) {
        seen.add(goal.tag);
        goal = goal.parent === null ? undefined : goals.get(goal.parent);
    }
    return [...seen];
}
/** Tasks carry finer tags than the records (R1.3e under R1.3), so the longest record that covers the tag is its goal. */
function deepestGoal(tag, goals) {
    return [...goals.values()].filter((goal) => covers(goal.tag, tag)).reduce((best, goal) => (best === undefined || goal.tag.length > best.tag.length ? goal : best), undefined);
}
/** A digit after the prefix is another number, not a finer tag: R1.10 is no part of R1.1. */
function covers(goal, tag) {
    return tag.startsWith(goal) && !/^\d/.test(tag.slice(goal.length));
}
function goalProgress(goal, tasks, today) {
    const doneOn = tasks.filter(({ task }) => task.status === 'done').map(({ task }) => today.zone.day(new Date(task.statusAt)));
    const open = tasks.filter(({ task }) => ACTIVE_STATUSES.includes(task.status)).length;
    const paceFrom = dayFrom(today, 1 - GOAL_PACE_DAYS);
    const pace = doneOn.filter((day) => day >= paceFrom).length / GOAL_PACE_DAYS;
    const forecast = open > 0 && pace > 0 ? dayFrom(today, Math.ceil(open / pace)) : null;
    return {
        tag: goal.tag,
        title: goal.title,
        start: goal.start,
        target: goal.target,
        parent: goal.parent,
        slips: goal.slips,
        done: doneOn.length,
        open,
        doneDays: doneDays(doneOn),
        pace,
        forecast,
        state: stateOf(goal, doneOn.length, open, forecast, today.day),
        tasks,
    };
}
function stateOf(goal, done, open, forecast, today) {
    if (open === 0 && done > 0)
        return 'done';
    if (goal.target < today)
        return 'late';
    if (open === 0)
        return 'on track';
    if (forecast === null)
        return today < goal.start ? 'on track' : 'at risk';
    return forecast <= goal.target ? 'on track' : 'at risk';
}
function doneDays(days) {
    const counts = new Map();
    for (const day of days)
        counts.set(day, (counts.get(day) ?? 0) + 1);
    return [...counts].map(([day, done]) => ({ day, done })).sort((a, b) => (a.day < b.day ? -1 : 1));
}
function dayFrom(today, days) {
    return formatUtcDay(new Date(today.ms + days * MS_PER_DAY));
}
