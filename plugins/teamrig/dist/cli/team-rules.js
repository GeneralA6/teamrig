import { loadTree } from "./tree.js";
/**
 * The rules.md files a session of `kit`'s team is shown at start: each team above its own, root first and parent
 * last (a team the tree did not load is left out), then its own team's.
 */
export function teamRulesFilesOf(kit, kitTree) {
    const above = kitTree.tree.ancestorsOf(kit.paths.team).flatMap((ancestor) => {
        const team = kitTree.teams.get(ancestor);
        return team === undefined ? [] : [{ ancestor, path: team.kit.paths.teamRules }];
    });
    return [...above, { ancestor: undefined, path: kit.paths.teamRules }];
}
/**
 * The kept local rules [ruleConflicts] of each team above `kit`'s, root first and parent last, each tagged with its
 * team (a team the tree did not load is left out). Its own team's stay in its config: `rules keep` and `forget` write
 * that config back, so these are never merged into it.
 */
export function keptRulesAboveOf(kit, kitTree) {
    return kitTree.tree
        .ancestorsOf(kit.paths.team)
        .flatMap((ancestor) => (kitTree.teams.get(ancestor)?.config.ruleConflicts ?? []).map((kept) => ({ ...kept, team: ancestor })));
}
/** The paths of `teamRulesFilesOf`, existing or not, for the scans that look for them. */
export async function teamRulesPathsOf(runtime, kit) {
    return teamRulesFilesOf(kit, await loadTree(runtime)).map((file) => file.path);
}
/** The team rules files of `teamRulesFilesOf` that exist, read in its order. */
export async function readTeamRules(runtime, kit, kitTree) {
    const rules = [];
    for (const file of teamRulesFilesOf(kit, kitTree)) {
        const text = await runtime.files.read(file.path);
        if (text !== undefined) {
            rules.push({ ...file, text });
        }
    }
    return rules;
}
