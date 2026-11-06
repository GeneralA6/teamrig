import { teamDecisions } from "../decisions/team.js";
import { teamZone } from "./kit.js";
import { subtreeOf } from "./roll-up.js";
/**
 * The batch of the owner's decisions that holds team `own`'s waits on the owner (T1018): the one the lead at its tree's
 * root asks, over the root's register and every register under it, depth-first (subtreeOf), each on its own team's
 * clock, against the batches the root's lead asked and on the root's batch times. `own` is taken as given, a register
 * just written say; every other register is read without its lock. With the root not loaded, the batch is `own`'s and
 * its subtree's.
 */
export async function ownerBatchOf(runtime, own, loaded, now) {
    const askedBy = loaded.tree.ownerLeadAbove(own.team);
    const root = askedBy === undefined ? undefined : loaded.teams.get(askedBy.team);
    const top = root ?? loaded.teams.get(own.team);
    const rolled = top === undefined ? [] : (await subtreeOf(runtime, top, loaded)).teams;
    const [first = own, ...rest] = rolled.map((team) => (team.team === own.team ? own : batchedOf(team)));
    const registers = rest.map((team) => registerOf(runtime, team, team.team));
    const batch = await teamDecisions(runtime.files, first.paths, first.config, [registerOf(runtime, first, undefined), ...registers], now);
    return { batch, askedBy };
}
function batchedOf({ team, config, paths, snapshot, elsewhere, ranking }) {
    return { team, config, paths, tasks: snapshot.state.tasks, elsewhere, ranking };
}
/** A register of the batch, labelled with its team, `label`, unless it is the batch's own. */
function registerOf(runtime, { config, tasks, elsewhere, ranking }, label) {
    return { team: label, tasks, ownerMarker: config.register.ownerSource, requireGate: config.register.requireDecisionCard, zone: teamZone(config, runtime), elsewhere, ranking };
}
