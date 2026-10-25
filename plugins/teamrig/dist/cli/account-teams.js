import { accountOf, accountTeamsOf, accountWeekOf } from "../budget/account.js";
import { LiftLog } from "../budget/lift.js";
import { budgetSplitOf } from "../budget/parts.js";
import { snapshotDirOf, weekUseAt } from "../budget/snapshot.js";
import { claudeConfigDir } from "../core/home.js";
import { loadTree } from "./tree.js";
/**
 * The other teams of the kit home on the asking team's Claude account (`accountTeamsOf`), each split by its roster,
 * shares, lifts in force at `now` and queued work, read-only. Every team's config is read on each call.
 */
export async function otherTeamsOnAccount(runtime, asking, now, usedPct) {
    const { teams } = await loadTree(runtime);
    const configDir = claudeConfigDir(runtime.env, runtime.userHome);
    return accountTeamsOf(runtime.files, teams, {
        team: asking.team,
        account: accountOf(asking.config.budget, configDir),
        configDir,
        usageDir: asking.usageDir,
        now,
        usedPct,
    });
}
/**
 * The team that asks, split by its roster, `budget.sessions`, lifts in force at `now` and queued work, beside the
 * other teams on its account (`otherTeamsOnAccount`): what the account's day and spare are split among.
 */
export async function teamsOnAccountOf(runtime, asking, now, usedPct) {
    const { lifts } = await new LiftLog(runtime.files, asking.liftsPath).read();
    const split = budgetSplitOf({ team: asking.team, ids: asking.ids, sessions: asking.config.budget.sessions, leads: asking.config.leads, work: asking.work, lifts, now, usedPct });
    return { split, others: await otherTeamsOnAccount(runtime, asking, now, usedPct) };
}
/**
 * The week's use at `now` from the newest status line reading on the asking team's Claude account (`accountWeekOf`):
 * its own folder's, then the other teams' on the account, read-only, each through its week summary when it keeps one,
 * so a team whose tabs are idle reads the account's newest week %. Every team's config is read on each call.
 */
export async function weekUseOnAccount(runtime, budget, paths, now) {
    const { teams } = await loadTree(runtime);
    const configDir = claudeConfigDir(runtime.env, runtime.userHome);
    const fold = await accountWeekOf(runtime.files, teams, snapshotDirOf(budget, paths), { account: accountOf(budget, configDir), configDir, now });
    return weekUseAt(fold, now);
}
