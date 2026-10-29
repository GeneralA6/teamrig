import { join, resolve } from 'node:path';
import { TeamTree, teamNodeOf } from "../config/tree.js";
import { resolveKitHome } from "../core/home.js";
import { ID_PATTERN } from "../core/ids.js";
import { openKit, rosterOf } from "./kit.js";
/**
 * Reads every team config under `<kit home>/teams/`, read-only. A folder with no config or one that
 * cannot be read is left out: that team's own commands report it, and `doctor` names a parent left
 * out this way as missing.
 */
export async function loadTree(runtime) {
    const folders = await runtime.files.list(join(resolveKitHome(runtime.env, runtime.userHome), 'teams'));
    const teams = new Map();
    for (const team of folders.filter((folder) => ID_PATTERN.test(folder)).sort()) {
        const kit = await openKit(runtime, team);
        if (kit.load.status === 'loaded') {
            const { config } = kit.load;
            teams.set(team, { kit, config, roster: await rosterOf(runtime, kit, config) });
        }
    }
    const nodes = [...teams].map(([team, { config, roster }]) => teamNodeOf(team, config, roster));
    return { tree: new TeamTree(nodes), teams };
}
/**
 * The sessions of the other teams of a team's tree that read its skills folder too: each such team's own `check` lints
 * the skills its sessions own there, so the team's lints leave those out (T1473). A team whose `paths.skills` names
 * another folder never lints this one, so its sessions are not counted.
 */
export function skillOwnersElsewhere(loaded, paths) {
    const { tree, teams } = loaded;
    const shares = ([other, { kit }]) => other !== paths.team && tree.sameTree(other, paths.team) && resolve(kit.paths.skills) === resolve(paths.skills);
    return new Set([...teams].filter(shares).flatMap(([, { config }]) => config.sessions));
}
/**
 * The parent team's lead, who approves the team's lead's own work (T1140); undefined for a root team, read without the
 * tree, or for a team whose parent has no config, which `doctor` names.
 */
export async function leadAboveOf(runtime, team, config) {
    if (config.team?.parent === undefined) {
        return undefined;
    }
    return (await loadTree(runtime)).tree.parentLeadOf(team);
}
