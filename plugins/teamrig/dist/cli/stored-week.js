import { join } from 'node:path';
import { OUTSIDE_ID } from "../budget/measure.js";
import { UsageStore } from "../budget/store.js";
import { calibrationOf, MeterLog } from "../budget/calibration.js";
import { teamWeekOf } from "../budget/team-week.js";
import { rateOf } from "../budget/week.js";
import { accountWeekOn } from "./account-teams.js";
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
 * status-line reading on the account, in the account's week files (`accountWeekOn`), no transcript measured.
 */
export async function readStoredWeek(runtime, paths, config, now) {
    return storedWeekOn(runtime, paths, config, now, await accountWeekOn(runtime, config.budget, paths, now));
}
async function storedWeekOn(runtime, paths, config, now, account) {
    const { budget, sessions } = config;
    const states = [...(await readStoredUsage(runtime, paths, sessions)).values()];
    return teamWeekOf(runtime.files, account.paths, { budget, now, statusUse: account.statusUse, states });
}
/**
 * The week's W per percent as `teamrig budget` reads it: learned from the account's meter log (`accountWeekOn`), else
 * from `budget.weeklyLimitW`, which read no usage store, else the stored week's estimate; undefined while none is known.
 * It prices a spend over several days (a task's size); a spend made now takes `readTodayWPerPct`.
 */
export async function readWPerPct(runtime, paths, config, now) {
    const account = await accountWeekOn(runtime, config.budget, paths, now);
    const calibration = calibrationOf(await new MeterLog(runtime.files, account.paths.meterLog).read(now));
    return rateOf(calibration, config.budget, undefined)?.wPerPct ?? (await storedWeekOn(runtime, paths, config, now, account)).wPerPct;
}
/**
 * Today's W per percent of the week, as `teamrig budget` prices today's rows (budget/report.ts): today's W over the
 * status line's points today once they span `TODAY_RATE_SPAN_PTS`, else the week's rate (`readWPerPct`'s order);
 * undefined while no rate is known. It prices a spend made now, as a wake.
 */
export async function readTodayWPerPct(runtime, paths, config, now) {
    return (await readStoredWeek(runtime, paths, config, now)).todayWPerPct;
}
