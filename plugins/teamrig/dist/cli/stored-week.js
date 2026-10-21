import { join } from 'node:path';
import { OUTSIDE_ID } from "../budget/measure.js";
import { readSnapshots, weekUseOf } from "../budget/snapshot.js";
import { UsageStore } from "../budget/store.js";
import { calibrationOf, MeterLog } from "../budget/calibration.js";
import { teamWeekOf } from "../budget/team-week.js";
import { rateOf } from "../budget/week.js";
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
    return teamWeekOf(files, paths, { budget, now, statusUse, states });
}
/**
 * The week's W per percent as `teamrig budget` reads it: learned from the meter log, else from
 * `budget.weeklyLimitW`, which read no usage store, else the stored week's estimate; undefined while none is known.
 */
export async function readWPerPct(runtime, paths, config, now) {
    const calibration = calibrationOf(await new MeterLog(runtime.files, paths.meterLog).read(now));
    return rateOf(calibration, config.budget, undefined)?.wPerPct ?? (await readStoredWeek(runtime, paths, config, now)).wPerPct;
}
