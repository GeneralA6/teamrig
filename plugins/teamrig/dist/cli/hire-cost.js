import { surplusOf } from "../budget/burst.js";
import { addedSessionPct } from "../budget/parts.js";
import { workWeights } from "../budget/work.js";
import { teamsOnAccountOf } from "./account-teams.js";
import { readStoredWeek } from "./stored-week.js";
/**
 * SCALE-OUT's budget: the team's part of the spare the account's week projects (`surplusOf`), split among the teams on
 * the account by the same weights as the day (src/cli/account-teams.ts `teamsOnAccountOf`, lifts in force at the
 * week's use `week.usedPct`), so two leads never hire against the same spare; and a new hire's part of the account's
 * daily budget today (src/budget/parts.ts `addedSessionPct`), beside each session's share, queued work (`tasks`) and
 * lift. The day is read as a hook reads it (`readStoredWeek`): no hire price without a W per percent (none learned
 * from the meter log, no `budget.weeklyLimitW`, and a meter that does not reach back to the week's start).
 */
export async function readScaleOutBudget(runtime, paths, config, tasks, week, now) {
    const { usedPct, window } = week;
    if (usedPct === undefined || window === undefined) {
        return { spare: undefined, hirePct: undefined };
    }
    const work = workWeights(tasks, config.register.priorities);
    const teams = await teamsOnAccountOf(runtime, { team: paths.team, config, usageDir: paths.usage, ids: config.sessions, liftsPath: paths.lifts, work }, now, usedPct);
    const spare = surplusOf({ window, now, usedPct, targetPct: config.budget.targetPct, config: config.burst, teams });
    if (spare === undefined) {
        return { spare, hirePct: undefined };
    }
    const { allowancePct } = await readStoredWeek(runtime, paths, config, now);
    return { spare, hirePct: allowancePct === undefined ? undefined : addedSessionPct(allowancePct, teams.split, teams.others) };
}
