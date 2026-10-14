import { join } from 'node:path';
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
