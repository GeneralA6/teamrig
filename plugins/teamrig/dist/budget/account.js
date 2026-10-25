import { join } from 'node:path';
import { LiftLog } from "./lift.js";
import { budgetSplitOf } from "./parts.js";
import { mergeWeekFolds, snapshotDirOf } from "./snapshot.js";
import { readFolderWeek } from "./week-summary.js";
import { cachedWork } from "./work.js";
/** The Claude account a team's week is on: its `budget.account`, else the Claude config dir, which signs in one account. */
export function accountOf(budget, configDir) {
    return budget.account ?? configDir;
}
/** The file in the asking team's usage folder that caches another team's queued work. */
export function workCacheFileOf(team) {
    return `work.cache.${team}.json`;
}
/**
 * The other teams of the kit home on the asking team's account, in the order of `teams`, each split by its roster,
 * `budget.sessions`, lifts in force and queued work, read-only. A register that cannot be read counts each of its
 * sessions at weight 1 (`cachedWork`) and a lift log that cannot be read holds no lift, so another team's folder
 * never stops this team's budget.
 */
export async function accountTeamsOf(files, teams, scope) {
    const others = [];
    for (const [team, { kit, config, roster }] of teams) {
        if (team === scope.team || accountOf(config.budget, scope.configDir) !== scope.account) {
            continue;
        }
        const lifts = await liftsOf(files, kit.paths.lifts);
        const work = await cachedWork(files, kit.paths.events, join(scope.usageDir, workCacheFileOf(team)), config.register.priorities);
        others.push(budgetSplitOf({ team, ids: roster.ids, sessions: config.budget.sessions, leads: config.leads, work, lifts, now: scope.now, usedPct: scope.usedPct }));
    }
    return others;
}
async function liftsOf(files, path) {
    try {
        return (await new LiftLog(files, path).read()).lifts;
    }
    catch {
        return [];
    }
}
/** A fold of no reading, for a folder that cannot be read. */
const NO_READING = { best: undefined, followedBy: undefined };
/**
 * The status line readings of the week on the asking team's account, folded, read-only: its own folder's (`own`),
 * then each other team's on the account in the order of `teams`, each folder once, through its week summary when it
 * keeps one (`readFolderWeek`). A team's tabs write only its own folder, so a team whose tabs are idle would show an
 * old week %; the merged fold takes the newest reading among them all. Another team's folder that cannot be read
 * gives no reading, so it never stops this team's budget.
 */
export async function accountWeekOf(files, teams, own, scope) {
    let fold = await readFolderWeek(files, own, scope.now);
    const read = new Set([own]);
    for (const { kit, config } of teams.values()) {
        const dir = snapshotDirOf(config.budget, kit.paths);
        if (!read.has(dir) && accountOf(config.budget, scope.configDir) === scope.account) {
            read.add(dir);
            fold = mergeWeekFolds(fold, await othersWeek(files, dir, scope.now));
        }
    }
    return fold;
}
async function othersWeek(files, dir, now) {
    try {
        return await readFolderWeek(files, dir, now);
    }
    catch {
        return NO_READING;
    }
}
