import { accountHolderOf, accountOf, accountTeamsOf, accountWeekOf } from "../budget/account.js";
import { LiftLog } from "../budget/lift.js";
import { budgetSplitOf } from "../budget/parts.js";
import { pausableOf } from "../budget/pause.js";
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
    const split = budgetSplitOf({ team: asking.team, ids: asking.ids, sessions: asking.config.budget.sessions, leads: asking.config.leads, work: asking.work, pausable: pausableOf(asking.config, asking.team, asking.ids), lifts, now, usedPct });
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
    return statusUseOf(runtime, teams, budget, paths, { account: accountOf(budget, configDir), configDir, now });
}
/** `weekUseOnAccount` with the week's files of the account (`AccountWeek`), from one read of every team's config. */
export async function accountWeekOn(runtime, budget, paths, now) {
    const { tree, teams } = await loadTree(runtime);
    const configDir = claudeConfigDir(runtime.env, runtime.userHome);
    const account = accountOf(budget, configDir);
    const statusUse = await statusUseOf(runtime, teams, budget, paths, { account, configDir, now });
    const holder = accountHolderOf(tree, paths.team, account, (team) => {
        const loaded = teams.get(team);
        return loaded === undefined ? undefined : accountOf(loaded.config.budget, configDir);
    });
    return { statusUse, paths: teams.get(holder)?.kit.paths ?? paths };
}
async function statusUseOf(runtime, teams, budget, paths, scope) {
    const fold = await accountWeekOf(runtime.files, teams, snapshotDirOf(budget, paths), scope);
    return weekUseAt(fold, scope.now);
}
