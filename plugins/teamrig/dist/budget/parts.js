import { DEFAULT_SESSION_SHARE } from "../config/defaults.js";
import { activeLift } from "./lift.js";
/** A session's weight in the split: its `share` times its queued work, at least 1 so a session with none still gets a part. */
function weightOf(split, id) {
    return (split.sessions[id]?.share ?? DEFAULT_SESSION_SHARE) * Math.max(1, split.work.get(id) ?? 0);
}
/**
 * The session's part of the team's daily budget (`allowancePct`, in percent of the week): a lifted session's is
 * its lift's part of it; what the lifts leave is split among the other sessions by weight. Recomputed with the
 * budget, so no session waits while the week has room and the parts never add up to more than the team's budget.
 */
export function sessionBudgetPct(allowancePct, session, split) {
    const liftedPart = split.lifted.get(session);
    if (liftedPart !== undefined) {
        return (allowancePct * liftedPart) / 100;
    }
    let liftedPct = 0;
    let weights = 0;
    for (const id of split.ids) {
        const part = split.lifted.get(id);
        if (part === undefined) {
            weights += weightOf(split, id);
        }
        else {
            liftedPct += part;
        }
    }
    const rest = (allowancePct * Math.max(0, 100 - liftedPct)) / 100;
    return weights > 0 ? (rest * weightOf(split, session)) / weights : 0;
}
/** The session's daily budget now, in percent of the week (`sessionBudgetPct`); undefined while the team's is unknown. */
export function dailyBudgetOf(allowancePct, session, split) {
    return allowancePct === undefined ? undefined : sessionBudgetPct(allowancePct, session, split);
}
/** The lifts in force at `now` (`activeLift`), as each lifted session's part of the team's budget. */
export function liftedParts(lifts, ids, now, usedPct) {
    const parts = new Map();
    for (const id of ids) {
        const lift = activeLift(lifts, id, now, usedPct);
        if (lift !== undefined) {
            parts.set(id, lift.partPct);
        }
    }
    return parts;
}
/** An id no roster holds (a session id starts with a lowercase letter), for the session `addedSessionPct` adds. */
const ADDED_SESSION = '+added';
/**
 * The part of the team's daily budget (`allowancePct`, in percent of the week) one more session would get: added at
 * the default share with no queued work, it takes its part out of the other sessions', as a new hire does.
 */
export function addedSessionPct(allowancePct, split) {
    return sessionBudgetPct(allowancePct, ADDED_SESSION, { ...split, ids: [...split.ids, ADDED_SESSION] });
}
