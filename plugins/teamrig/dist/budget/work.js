import { JsonlEventLog } from "../register/store.js";
/** The statuses whose tasks are a session's queued work: what it can work on now. */
const QUEUED = new Set(['open', 'in-progress']);
/**
 * Each session's queued work, the weight of its part of the team's daily budget: its open and in-progress tasks,
 * each weighed by its priority, the top priority as many as the config lists and the last 1 (p1..p5: 5..1). A
 * priority the config does not list weighs 1. A session with no queued work is not in the map.
 */
export function workWeights(tasks, priorities) {
    const ranked = priorities.map((priority) => priority.id).sort((a, b) => a - b);
    const weights = new Map();
    for (const task of tasks) {
        if (!QUEUED.has(task.status)) {
            continue;
        }
        const rank = ranked.indexOf(task.priority);
        weights.set(task.owner, (weights.get(task.owner) ?? 0) + (rank === -1 ? 1 : ranked.length - rank));
    }
    return weights;
}
/**
 * The sessions' queued work, read from the register at `eventsPath`; empty when the register cannot be read, so
 * every part falls back to its session's `share` and a damaged register never stops the budget.
 */
export async function readWork(files, eventsPath, priorities) {
    try {
        const { state } = await new JsonlEventLog(files, eventsPath).read();
        return workWeights(state.tasks.values(), priorities);
    }
    catch {
        return new Map();
    }
}
