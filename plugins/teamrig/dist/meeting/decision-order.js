import { WEEKDAYS } from "../config/types.js";
/** The band a task with no ranked place reads as: after every other. */
const LAST_BAND = 2;
/** The task and every active task of its register that needs it, directly or not, each once. */
export function unblockedBy(task, tree) {
    const found = new Map([[task.id, task]]);
    const queue = [...tree.neededBy(task.id)];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (!found.has(next.id)) {
            found.set(next.id, next);
            queue.push(...tree.neededBy(next.id));
        }
    }
    return [...found.values()];
}
function rankOver(tasks, tree, focus) {
    const places = tasks.flatMap((task) => tree.rankedOf(task) ?? []);
    return {
        band: places.reduce((best, place) => (place.band < best ? place.band : best), LAST_BAND),
        roadmap: places.some((place) => place.workClass === focus.roadmapClass),
        score: Math.max(0, ...places.map((place) => place.score)),
    };
}
function byRank(a, b) {
    return a.band - b.band || Number(b.roadmap) - Number(a.roadmap) || b.score - a.score;
}
/**
 * True for a decision that may wait for the weekly batch: every task it unblocks has a stored class that is neither
 * Roadmap nor Maintenance, and none expedites. A task with no class stays on the daily: read as the default class, every
 * unclassed decision would leave the owner's sight until the batch, the same reason a null class never parks a task.
 */
function waitsForBatch(tasks, tree, focus) {
    return tasks.every((task) => task.workClass !== null && task.workClass !== focus.roadmapClass && task.workClass !== focus.maintenanceClass && tree.rankedOf(task)?.band !== 0);
}
/**
 * True for a decision on `task` that waits for the weekly batch ({@link waitsForBatch} over what it unblocks): the one
 * rule the agenda and the owner's decision batch (src/decisions/batch.ts) both hold such a decision back by.
 */
export function waitsForWeeklyBatch(task, tree, focus) {
    return waitsForBatch(unblockedBy(task, tree), tree, focus);
}
/** The decisions of every register in one ranked list, a tie in the order handed in, split by {@link waitsForBatch}. */
export function decisionOrder(reads) {
    const ranked = reads
        .flatMap(({ tasks, tree, team, focus }) => tasks.map((task) => {
        const unblocked = unblockedBy(task, tree);
        return { decision: { task, tree, team }, rank: rankOver(unblocked, tree, focus), batched: waitsForBatch(unblocked, tree, focus) };
    }))
        .sort((a, b) => byRank(a.rank, b.rank));
    return {
        daily: ranked.filter((row) => !row.batched).map((row) => row.decision),
        improvements: ranked.filter((row) => row.batched).map((row) => row.decision),
    };
}
/** True on the UTC weekday the Improvements batch is asked. */
export function isImprovementsDay(now, day) {
    return WEEKDAYS[new Date(now).getUTCDay()] === day;
}
