import { formatAddress } from "../core/address.js";
import { readSnapshot } from "../register/register.js";
import { JsonlEventLog } from "../register/store.js";
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf } from "./kit.js";
import { RefusedError } from "./runtime.js";
import { loadTree } from "./tree.js";
async function rolledOf(runtime, team, { kit, config, roster }) {
    const snapshot = await readSnapshot(new JsonlEventLog(runtime.files, kit.paths.events));
    return { team, config, paths: kit.paths, roster, snapshot };
}
/**
 * The registers behind `list|check|plan --tree`: the caller's team and the teams under it. Only the
 * team's lead rolls up. Each register is read without its lock, as every read is, so nothing in
 * another team's folder is written.
 */
export async function rollUp(runtime, caller) {
    const { team } = await findTeam(runtime);
    const kit = await openKit(runtime, team);
    const config = requireConfig(kit, runtime, 'read');
    const id = sessionIdOf(await rosterOf(runtime, kit, config), caller);
    const { tree, teams } = await loadTree(runtime);
    const lead = tree.leadOf(team);
    const ownTeam = teams.get(team);
    if (ownTeam === undefined || lead !== id) {
        const named = lead === undefined ? '' : ` (${formatAddress({ team, id: lead })})`;
        throw new RefusedError(`--tree is for the team's lead${named}; ${formatAddress({ team, id })} reads its own team's tasks without it`);
    }
    const order = tree.descendantsOf(team);
    const below = [...teams].filter(([member]) => order.includes(member)).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
    const own = await rolledOf(runtime, team, ownTeam);
    const rolled = [own];
    for (const [member, loaded] of below) {
        rolled.push(await rolledOf(runtime, member, loaded));
    }
    return { own, teams: rolled };
}
