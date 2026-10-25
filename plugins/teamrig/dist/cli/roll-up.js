import { formatAddress } from "../core/address.js";
import { JsonlEventLog } from "../register/store.js";
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf } from "./kit.js";
import { RefusedError } from "./runtime.js";
import { TreeTasks } from "./tree-tasks.js";
import { loadTree } from "./tree.js";
async function readOf(runtime, team, { kit, config, roster }) {
    const log = new JsonlEventLog(runtime.files, kit.paths.events);
    return { team, config, paths: kit.paths, roster, snapshot: await log.read(), history: () => log.readHistory() };
}
/**
 * The registers behind `list|check|plan --tree`: the caller's team and the teams under it. Only the
 * team's lead rolls up. Each register is read without its lock, as every read is, so nothing in
 * another team's folder is written. A register the roll-up reads is not read again for another team's tasks elsewhere.
 */
export async function rollUp(runtime, caller) {
    const { team } = await findTeam(runtime);
    const kit = await openKit(runtime, team);
    const config = requireConfig(kit, runtime, 'read');
    const id = sessionIdOf(await rosterOf(runtime, kit, config), caller);
    const kitTree = await loadTree(runtime);
    const { tree, teams } = kitTree;
    const lead = tree.leadOf(team);
    const ownTeam = teams.get(team);
    if (ownTeam === undefined || lead !== id) {
        const named = lead === undefined ? '' : ` (${formatAddress({ team, id: lead })})`;
        throw new RefusedError(`--tree is for the team's lead${named}; ${formatAddress({ team, id })} reads its own team's tasks without it`);
    }
    const order = tree.descendantsOf(team);
    const below = [...teams].filter(([member]) => order.includes(member)).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
    const ownRead = await readOf(runtime, team, ownTeam);
    const belowRead = [];
    for (const [member, loaded] of below) {
        belowRead.push(await readOf(runtime, member, loaded));
    }
    const treeTasks = new TreeTasks(runtime, kitTree, new Map([ownRead, ...belowRead].map((read) => [read.team, read.snapshot])));
    const withElsewhere = async (read) => ({ ...read, elsewhere: await treeTasks.elsewhereFor(read.team) });
    const own = await withElsewhere(ownRead);
    const rolled = [own];
    for (const read of belowRead) {
        rolled.push(await withElsewhere(read));
    }
    return { own, teams: rolled };
}
