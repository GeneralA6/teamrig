import { accountOf, accountTeamsOf } from "../budget/account.js";
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
