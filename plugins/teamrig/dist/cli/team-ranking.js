import { likeSizing, treeRanking } from "../register/ranking.js";
import { readTaskSpend } from "./task-spend.js";
import { KitTreeGoals } from "./tree-goals.js";
/**
 * The ranking of one team's tree (T2076): its focus config, the goals its tasks may serve, and each task's size from its
 * own size, its metered spend and the spend of like tasks among `tasks`. Each team reads its own paths and config, as a
 * sub-team's sessions meter in its own home. With no rate known yet, spend reads 0 and tasks fall to their sizes; so
 * too with a use store that cannot be read, which costs the ranking its metered sizes, never the list that prints it.
 */
export async function teamRanking(runtime, paths, config, tasks) {
    const now = runtime.clock.now();
    const [goals, spend] = await Promise.all([
        new KitTreeGoals(runtime, paths, config).all(),
        readTaskSpend(runtime, paths, config, now).catch(() => undefined),
    ]);
    // A null base counts a task's whole cost: a like task is measured by all it took, and a sized task's size wins anyway.
    const spentOf = (id) => spend?.({ id, sizeBase: null }) ?? 0;
    return treeRanking({ focus: config.focus, ownerSource: config.register.ownerSource, goals, sizing: likeSizing(tasks, config.focus, spentOf, now) });
}
