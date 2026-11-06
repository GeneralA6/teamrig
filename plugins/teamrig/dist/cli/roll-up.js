import { formatAddress } from "../core/address.js";
import { JsonlEventLog } from "../register/store.js";
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf } from "./kit.js";
import { RefusedError } from "./runtime.js";
import { teamRanking } from "./team-ranking.js";
import { TreeTasks } from "./tree-tasks.js";
import { loadTree } from "./tree.js";
async function readOf(runtime, team, { kit, config, roster }, kitTree) {
    const log = new JsonlEventLog(runtime.files, kit.paths.events);
    const snapshot = await log.read();
    const ranking = await teamRanking(runtime, kit.paths, config, snapshot.state.tasks.values());
    return { team, config, paths: kit.paths, roster, snapshot, history: () => log.readHistory(), above: kitTree.tree.parentLeadOf(team), ranking };
}
/**
 * The registers of the team `own` and of every team under it in `kitTree`, depth-first, its own first, each with the
 * tasks the others hold. Each is read without its lock, as every read is, so nothing in another team's folder is
 * written, and a register read here is not read again for another team's tasks elsewhere.
 */
export async function subtreeOf(runtime, own, kitTree) {
    const team = own.kit.paths.team;
    const order = kitTree.tree.descendantsOf(team);
    const below = [...kitTree.teams].filter(([member]) => order.includes(member)).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
    const ownRead = await readOf(runtime, team, own, kitTree);
    const belowRead = [];
    for (const [member, loaded] of below) {
        belowRead.push(await readOf(runtime, member, loaded, kitTree));
    }
    const treeTasks = new TreeTasks(runtime, kitTree, new Map([ownRead, ...belowRead].map((read) => [read.team, read.snapshot])));
    const withElsewhere = async (read) => ({ ...read, elsewhere: await treeTasks.elsewhereFor(read.team) });
    const rolledOwn = await withElsewhere(ownRead);
    const rolled = [rolledOwn];
    for (const read of belowRead) {
        rolled.push(await withElsewhere(read));
    }
    return { own: rolledOwn, teams: rolled };
}
/** The registers behind `list|check|plan --tree`: the caller's team and the teams under it (subtreeOf). Only the team's lead rolls up. */
export async function rollUp(runtime, caller) {
    const { team } = await findTeam(runtime);
    const kit = await openKit(runtime, team);
    const config = requireConfig(kit, runtime, 'read');
    const roster = await rosterOf(runtime, kit, config);
    const id = sessionIdOf(roster, caller);
    const kitTree = await loadTree(runtime);
    const lead = kitTree.tree.leadOf(team);
    if (lead !== id) {
        const named = lead === undefined ? '' : ` (${formatAddress({ team, id: lead })})`;
        throw new RefusedError(`--tree is for the team's lead${named}; ${formatAddress({ team, id })} reads its own team's tasks without it`);
    }
    return subtreeOf(runtime, { kit, config, roster }, kitTree);
}
