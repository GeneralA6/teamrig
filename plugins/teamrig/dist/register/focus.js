/**
 * The work class a task counts as (T2076): its own `workClass`, else the team's `focus.defaultClass`, so a task no one
 * classed ranks with team tooling, last. Pure, so the CLI and the pane read a class the same way.
 */
export function classOf(task, focus) {
    return task.workClass ?? focus.defaultClass;
}
/**
 * A goal and every goal up its parent chain, nearest first, each with its tag; it ends at a tag the team holds no goal
 * for. A chain is walked once per goal, so a damaged file's loop cannot hang it.
 */
export function goalChain(tag, goals) {
    const chain = [];
    const walked = new Set();
    for (let at = tag; at !== null && !walked.has(at);) {
        walked.add(at);
        const goal = goals.get(at);
        if (goal === undefined) {
            break;
        }
        chain.push([at, goal]);
        at = goal.parent;
    }
    return chain;
}
/**
 * The goal that gives a task its best (lowest) rank (T2083): over each goal it names and every goal up that goal's
 * parent chain, so a task on an unranked key result takes its objective's rank, and names that objective. Null when
 * none of them is ranked, or the task names no goal the team holds.
 */
export function servedGoalOf(task, goals) {
    let best = null;
    for (const tag of task.goals) {
        for (const [at, goal] of goalChain(tag, goals)) {
            if (goal.rank !== null && (best === null || goal.rank < best.rank)) {
                best = { tag: at, rank: goal.rank };
            }
        }
    }
    return best;
}
/** The best rank a task serves, as `servedGoalOf` finds it; null: none. */
export function rankOf(task, goals) {
    return servedGoalOf(task, goals)?.rank ?? null;
}
