import { accountHolderOf, accountsOf, accountTeamsOf, accountWeekOf } from "../budget/account.js";
import { readConfigDir } from "../budget/config-dir.js";
import { LiftLog } from "../budget/lift.js";
import { budgetSplitOf } from "../budget/parts.js";
import { pausableOf } from "../budget/pause.js";
import { snapshotDirOf, weekUseAt } from "../budget/snapshot.js";
import { claudeConfigDir } from "../core/home.js";
import { loadTree } from "./tree.js";
/**
 * The asking team's Claude account and each team's of the kit home (`accountsOf`), read-only: each team's from its config
 * and the config dir its sessions last started in (budget/config-dir.ts), the asking team's from the one this process
 * runs in, so two logins with no `budget.account` read as two accounts, and teams on one login as one.
 */
export async function kitHomeAccountsOf(runtime, teams, asker) {
    const facts = new Map();
    for (const [team, { kit, config }] of teams) {
        facts.set(team, { account: config.budget.account, configDir: await readConfigDir(runtime.files, kit.paths.configDirRecord) });
    }
    return accountsOf({ team: asker.team, account: asker.budget.account }, facts, claudeConfigDir(runtime.env, runtime.userHome));
}
/**
 * The other teams of the kit home on the asking team's Claude account (`accountTeamsOf`), each split by its roster,
 * shares, lifts in force at `now` and queued work, read-only. Every team's config is read on each call.
 */
export async function otherTeamsOnAccount(runtime, asking, now, usedPct) {
    const { teams } = await loadTree(runtime);
    const accounts = await kitHomeAccountsOf(runtime, teams, { team: asking.team, budget: asking.config.budget });
    return accountTeamsOf(runtime.files, teams, { team: asking.team, ...accounts, usageDir: asking.usageDir, now, usedPct });
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
    const accounts = await kitHomeAccountsOf(runtime, teams, { team: paths.team, budget });
    return statusUseOf(runtime, teams, budget, paths, { ...accounts, now });
}
/** `weekUseOnAccount` with the week's files of the account (`AccountWeek`), from one read of every team's config. */
export async function accountWeekOn(runtime, budget, paths, now) {
    const { tree, teams } = await loadTree(runtime);
    const accounts = await kitHomeAccountsOf(runtime, teams, { team: paths.team, budget });
    const { account } = accounts;
    const statusUse = await statusUseOf(runtime, teams, budget, paths, { ...accounts, now });
    const accountOfTeam = (team) => accounts.accounts.get(team);
    const holder = accountHolderOf(tree, paths.team, account, accountOfTeam);
    const keepsHere = (team) => team !== paths.team && accountOfTeam(team) === account && accountHolderOf(tree, team, account, accountOfTeam) === holder;
    const peers = [...teams].filter(([team]) => keepsHere(team)).map(([team, loaded]) => ({ team, usage: loaded.kit.paths.usage, ids: loaded.roster.ids }));
    return { account, statusUse, paths: teams.get(holder)?.kit.paths ?? paths, keeper: holder, peers };
}
async function statusUseOf(runtime, teams, budget, paths, scope) {
    const fold = await accountWeekOf(runtime.files, teams, snapshotDirOf(budget, paths), scope);
    return weekUseAt(fold, scope.now);
}
