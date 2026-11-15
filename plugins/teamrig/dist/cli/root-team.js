import { openKit } from "./kit.js";
/**
 * The teams above `own`, up its `team.parent` links, its parent first and the root last; empty for a root. Undefined
 * when a config on the way does not load; a loop of parent links ends at the last team before the first one met again.
 */
export async function teamsAboveOf(runtime, own) {
    const seen = new Set([own.kit.paths.team]);
    const above = [];
    let current = own;
    for (let parent = own.config.team?.parent; parent !== undefined && !seen.has(parent); parent = current.config.team?.parent) {
        seen.add(parent);
        const kit = await openKit(runtime, parent);
        if (kit.load.status !== 'loaded') {
            return undefined;
        }
        current = { kit, config: kit.load.config };
        above.push(current);
    }
    return above;
}
/**
 * The root of the tree `own` sits in (teamsAboveOf), whose lead writes the tree's day schedule; `own` for a root.
 * Undefined when a config on the way does not load.
 */
export async function rootTeamOf(runtime, own) {
    const above = await teamsAboveOf(runtime, own);
    return above === undefined ? undefined : (above.at(-1) ?? own);
}
