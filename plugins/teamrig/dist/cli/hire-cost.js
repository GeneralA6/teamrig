import { LiftLog } from "../budget/lift.js";
import { addedSessionPct, liftedParts } from "../budget/parts.js";
import { workWeights } from "../budget/work.js";
import { readStoredWeek } from "./stored-week.js";
/**
 * What a new hire would spend a day, as `check`'s SCALE-OUT prices a slice (src/hiring/scale-out.ts): its part of the
 * team's daily budget today (src/budget/parts.ts `addedSessionPct`), beside each session's share, queued work
 * (`tasks`) and lift in force. The week is read as a hook reads it (`readStoredWeek`). Undefined while the team's daily budget is unknown: no reading of the
 * week's use, or no W per percent (none learned from the meter log, no `budget.weeklyLimitW`, and a meter that does not reach
 * back to the week's start).
 */
export async function readHirePct(runtime, paths, config, tasks, now) {
    const { budget, sessions } = config;
    const week = await readStoredWeek(runtime, paths, config, now);
    if (week.allowancePct === undefined) {
        return undefined;
    }
    const { lifts } = await new LiftLog(runtime.files, paths.lifts).read();
    const lifted = liftedParts(lifts, sessions, now, week.usedPct);
    return addedSessionPct(week.allowancePct, { ids: sessions, sessions: budget.sessions, work: workWeights(tasks, config.register.priorities), lifted });
}
