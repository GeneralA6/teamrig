import { quantile } from "../core/quantile.js";
import { MS_PER_DAY } from "../core/time.js";
import { classOf, prepRead, servedGoalOf } from "./focus.js";
/** How long a finished task measures its like tasks. The contract holds no config key for it (T2076 design section 3). */
const LIKE_WINDOW_DAYS = 14;
/** The class of a row, which may not carry one. */
function rowClass(task, focus) {
    return classOf({ workClass: task.workClass ?? null }, focus);
}
/** The ranking of a team's tree. */
export function treeRanking({ focus, ownerSource, goals, sizing }) {
    return {
        focus,
        ownerSource,
        classOf: (task) => rowClass(task, focus),
        goalOf: (task) => servedGoalOf({ goals: task.goals ?? [] }, goals),
        prepOf: (task) => prepRead({ prepares: task.prepares ?? null }, goals),
        sizingOf: sizing,
    };
}
/** Sizing by a task's own size alone, for a reader with no spend to read: an unsized task takes the default size. */
export function ownSizing(task) {
    return { size: task.size ?? null, spentPct: 0, likeMedianPct: undefined };
}
/** Which tasks are alike: same class and type. */
function likeKey(task, focus) {
    return `${rowClass(task, focus)}\n${task.type ?? ''}`;
}
/** Whether a task measures its like tasks: done inside the window that starts at `since`. A dropped task is no size of finished work. */
function measures(task, since) {
    return task.status === 'done' && Date.parse(task.statusAt) >= since;
}
function windowStart(now) {
    return now - LIKE_WINDOW_DAYS * MS_PER_DAY;
}
/**
 * The tasks that measure their like tasks at `now`, with only what {@link likeMedians} reads of them. Those of a later
 * time are among them, as the window only moves on, or were done since, which only a register write does: so a list
 * kept with the register's stamps (src/budget/work.ts `cachedWork`) gives the medians the whole register gives.
 */
export function likeTasksOf(tasks, now) {
    const since = windowStart(now);
    return [...tasks].filter((task) => measures(task, since)).map(({ id, status, statusAt, workClass, type }) => ({ id, status, statusAt, workClass, type }));
}
/**
 * The median spend per kind of task, by its like key, of those done inside the window. One with no spend is left out:
 * 0 means unmetered, not free, and a median of 0 falls to the floor and multiplies a score. The meter keeps 8 days, so
 * a task done before them reads 0 and leaves too, and one started before them reads short; a compaction retires only
 * what the meter has already lost (RETAIN_DAYS).
 */
function likeMedianMap(tasks, focus, spentOf, now) {
    const since = windowStart(now);
    const kinds = new Map();
    for (const task of tasks) {
        const spent = measures(task, since) ? spentOf(task.id) : 0;
        if (spent > 0) {
            const key = likeKey(task, focus);
            const kind = kinds.get(key) ?? { workClass: rowClass(task, focus), type: task.type, spent: [] };
            kind.spent.push(spent);
            kinds.set(key, kind);
        }
    }
    const medians = new Map();
    for (const [key, { workClass, type, spent }] of kinds) {
        const pct = quantile([...spent].sort((a, b) => a - b), 0.5);
        if (pct !== null) {
            medians.set(key, { workClass, type, pct });
        }
    }
    return medians;
}
/**
 * The median spend per kind of task, as {@link likeSizing} sizes by it, by class and then type, an unset type first:
 * for a reader that cannot meter tasks (src/budget/task-week-summary.ts), which sizes by {@link storedSizing}.
 * `spentOf` gives a task's whole cost in percent of the week, 0 when none is known.
 */
export function likeMedians(tasks, focus, spentOf, now) {
    return [...likeMedianMap(tasks, focus, spentOf, now).values()].sort((a, b) => a.workClass.localeCompare(b.workClass) || (a.type ?? '').localeCompare(b.type ?? ''));
}
/**
 * Sizing by a task's size, its spend, and the spend of like tasks, each in percent of the week. `spentOf` gives what a
 * task cost past a base, 0 when none is known. A sized task counts from its base, as a size set on a started task is
 * what was left then; a like task counts in full, as it is measured by all it took. The medians are read once here, not
 * per task.
 */
export function likeSizing(tasks, focus, spentOf, now) {
    const medians = likeMedianMap(tasks, focus, (id) => spentOf({ id, sizeBase: null }), now);
    return (task) => ({ size: task.size ?? null, spentPct: spentOf({ id: task.id, sizeBase: task.sizeBase ?? null }), likeMedianPct: medians.get(likeKey(task, focus))?.pct });
}
/**
 * Sizing from spend read elsewhere (src/budget/task-week-summary.ts), for a reader that cannot meter tasks, as the
 * pane's lists cannot: {@link likeSizing}'s twin, so a task sizes the same in both, the medians matched by the same
 * like key.
 */
export function storedSizing(stored, focus) {
    const spent = new Map(Object.entries(stored.spentPct));
    const medians = new Map(stored.likeMedians.map((median) => [likeKey(median, focus), median.pct]));
    return (task) => ({ size: task.size ?? null, spentPct: spent.get(task.id) ?? 0, likeMedianPct: medians.get(likeKey(task, focus)) });
}
