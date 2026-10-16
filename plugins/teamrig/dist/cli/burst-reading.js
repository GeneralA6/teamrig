import { BurstLog } from "../budget/burst-log.js";
import { readSnapshots, weekUseOf } from "../budget/snapshot.js";
import { snapshotDirOf } from "./commands/budget.js";
export async function readBursts(runtime, paths, budget, now) {
    const { records } = await new BurstLog(runtime.files, paths.bursts).read();
    const use = weekUseOf(await readSnapshots(runtime.files, snapshotDirOf(budget, paths)), now);
    return { records, usedPct: use?.usedPct };
}
