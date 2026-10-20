import { join } from 'node:path';
import { OUTSIDE_ID } from "../budget/measure.js";
import { PeriodStore } from "../budget/period.js";
import { readSnapshots, weekUseOf } from "../budget/snapshot.js";
import { UsageStore } from "../budget/store.js";
import { limitWPerPct, meteredOf, readWeek } from "../budget/week.js";
import { snapshotDirOf } from "./commands/budget.js";
/**
 * The week as a hook reads it: each session's use as last stored, the use outside the team and the newest
 * status-line reading, no transcript measured.
 */
export async function readStoredWeek(runtime, paths, config, now) {
    const { files } = runtime;
    const { budget, sessions } = config;
    const team = new UsageStore(files, paths.usage);
    const states = [];
    for (const id of sessions) {
        states.push((await team.load(id)).state);
    }
    states.push((await new UsageStore(files, join(paths.usage, 'outside')).load(OUTSIDE_ID)).state);
    const statusUse = weekUseOf(await readSnapshots(files, snapshotDirOf(budget, paths)), now);
    const period = await new PeriodStore(files, paths.period).periodAt(budget, statusUse, now, meteredOf(budget, states, now));
    return readWeek({ budget, now, statusUse, period, states });
}
/**
 * The week's W per percent as `teamrig budget` reads it: from `budget.weeklyLimitW`, which reads no file, else the
 * stored week's estimate; undefined while neither is known.
 */
export async function readWPerPct(runtime, paths, config, now) {
    return limitWPerPct(config.budget) ?? (await readStoredWeek(runtime, paths, config, now)).wPerPct;
}
