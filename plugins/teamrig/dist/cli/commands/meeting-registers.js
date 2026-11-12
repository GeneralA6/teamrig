import { formatAddress } from "../../core/address.js";
import { taskTreeOf } from "./register.js";
/**
 * The registers an owner's meeting covers, as the agenda and the meeting's agenda panel read them: the lead's own
 * and every team under it (subtreeOf), each on its own config and clock, so both list the same cards in one order.
 */
/** One register as the agenda reads its waits on the owner: its tasks, its tree and its own config's settings. */
export function agendaRegisterOf(rolled, runtime) {
    return {
        tasks: [...rolled.snapshot.state.tasks.values()],
        tree: taskTreeOf(rolled, runtime),
        ownerMarker: rolled.config.register.ownerSource,
        requireGate: rolled.config.register.requireDecisionCard,
        focus: rolled.config.focus,
        dedicatedOwners: rolled.config.decisions.dedicatedOwners,
    };
}
/** What the agenda asks the owner's cards from: the lead's register, each team under it, the day for the batch. */
export function decisionAgendaOf({ own, teams }, runtime, now) {
    return {
        ...agendaRegisterOf(own, runtime),
        below: teams.filter((rolled) => rolled.team !== own.team).map((rolled) => ({ team: rolled.team, ...agendaRegisterOf(rolled, runtime) })),
        now,
        improvementsDay: own.config.focus.improvementsDay,
    };
}
/** Who records the owner's decisions on a register: the lead by its id in its own team, by `<team>/<id>` in a team under it. */
export function decidedByOf(rolled, own, lead) {
    return rolled.team === own.team ? lead : formatAddress({ team: own.team, id: lead });
}
