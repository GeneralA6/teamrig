import { join } from 'node:path';
import { OUTSIDE_ID } from "../budget/measure.js";
import { UsageStore } from "../budget/store.js";
import { calibrationOf, MeterLog } from "../budget/calibration.js";
import { teamWeekOf } from "../budget/team-week.js";
import { rateOf } from "../budget/week.js";
import { weekUseOnAccount } from "./account-teams.js";
/** Each session's use as last stored, by its id, then the use outside the team under OUTSIDE_ID; no transcript measured. */
export async function readStoredUsage(runtime, paths, sessions) {
    const team = new UsageStore(runtime.files, paths.usage);
    const states = new Map();
    for (const id of sessions) {
        states.set(id, (await team.load(id)).state);
    }
    states.set(OUTSIDE_ID, (await new UsageStore(runtime.files, join(paths.usage, 'outside')).load(OUTSIDE_ID)).state);
    return states;
}
/**
 * The week as a hook reads it: each session's use as last stored, the use outside the team and the newest
 * status-line reading on the account (`weekUseOnAccount`), no transcript measured.
 */
export async function readStoredWeek(runtime, paths, config, now) {
    const { budget, sessions } = config;
    const states = [...(await readStoredUsage(runtime, paths, sessions)).values()];
    const statusUse = await weekUseOnAccount(runtime, budget, paths, now);
    return teamWeekOf(runtime.files, paths, { budget, now, statusUse, states });
}
/**
 * The week's W per percent as `teamrig budget` reads it: learned from the meter log, else from
 * `budget.weeklyLimitW`, which read no usage store, else the stored week's estimate; undefined while none is known.
 */
export async function readWPerPct(runtime, paths, config, now) {
    const calibration = calibrationOf(await new MeterLog(runtime.files, paths.meterLog).read(now));
    return rateOf(calibration, config.budget, undefined)?.wPerPct ?? (await readStoredWeek(runtime, paths, config, now)).wPerPct;
}
