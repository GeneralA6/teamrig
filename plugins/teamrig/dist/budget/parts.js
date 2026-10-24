import { DEFAULT_SESSION_SHARE } from "../config/defaults.js";
import { activeLift } from "./lift.js";
function weightOf(node) {
    return 'nodes' in node ? node.nodes.reduce((sum, each) => sum + weightOf(each), 0) : node.weight;
}
/**
 * A node's part of its parent's budget (`parentPct`, in percent of the week): a lifted node's is its lift's part of
 * it; what the lifts among `siblings` (the node among them) leave is split among the unlifted ones by weight.
 */
function partAmong(parentPct, node, siblings) {
    if (node.liftedPct !== undefined) {
        return (parentPct * node.liftedPct) / 100;
    }
    let liftedPct = 0;
    let weights = 0;
    for (const each of siblings) {
        if (each.liftedPct === undefined) {
            weights += weightOf(each);
        }
        else {
            liftedPct += each.liftedPct;
        }
    }
    const rest = (parentPct * Math.max(0, 100 - liftedPct)) / 100;
    return weights > 0 ? (rest * weightOf(node)) / weights : 0;
}
/**
 * The part of a budget (`budgetPct`, in percent of the week) that the node at `path` gets, `path` being its ids from
 * the top `nodes` down, split level by level (`partAmong`). Recomputed with the budget, so no node waits while the
 * week has room and the parts never add up to more than the budget. Undefined when no node is at `path`.
 */
export function partOf(budgetPct, nodes, path) {
    let pct = budgetPct;
    let level = nodes;
    let node;
    for (const id of path) {
        node = level.find((each) => each.id === id);
        if (node === undefined) {
            return undefined;
        }
        pct = partAmong(pct, node, level);
        level = 'nodes' in node ? node.nodes : [];
    }
    return node === undefined ? undefined : pct;
}
/** The team's sessions as split-tree nodes, each weighed by its `share` and queued work, with its lift in force. */
export function sessionNodesOf(split) {
    return split.ids.map((id) => ({
        id,
        liftedPct: split.lifted.get(id),
        weight: (split.sessions[id]?.share ?? DEFAULT_SESSION_SHARE) * Math.max(1, split.work.get(id) ?? 0),
    }));
}
/** The team as a split-tree node: its sessions (`sessionNodesOf`) under its id, its weight theirs summed. */
function teamGroupOf(split) {
    return { id: split.team, liftedPct: undefined, nodes: sessionNodesOf(split) };
}
/**
 * The team's part of the account's daily budget (`allowancePct`, in percent of the week), split among the teams on
 * the account (the team's `split` and the `others`, `accountTeamsOf`) by their sessions' summed weights: the whole
 * day while no other team is on the account. Undefined while the account's is unknown.
 */
export function teamPartOf(allowancePct, split, others = []) {
    if (allowancePct === undefined || others.length === 0) {
        return allowancePct;
    }
    return partOf(allowancePct, [split, ...others].map(teamGroupOf), [split.team]);
}
/**
 * The session's daily budget now, in percent of the week: its part (`partOf`) of its team's part (`teamPartOf`) of
 * the account's (`allowancePct`); a lift is its part of its team's. Undefined while the account's is unknown, or for
 * a session the split does not hold.
 */
export function dailyBudgetOf(allowancePct, session, split, others = []) {
    if (allowancePct === undefined) {
        return undefined;
    }
    // With no other team the session's path skips the team level: an exact split of the day, not one an ulp off it.
    return others.length === 0 ? partOf(allowancePct, sessionNodesOf(split), [session]) : partOf(allowancePct, [split, ...others].map(teamGroupOf), [split.team, session]);
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
 * The part of the account's daily budget (`allowancePct`, in percent of the week) one more session of the team would
 * get: added at the default share with no queued work, it takes its part out of the other sessions' on the account
 * (`others` being its other teams), as a new hire does.
 */
export function addedSessionPct(allowancePct, split, others = []) {
    return dailyBudgetOf(allowancePct, ADDED_SESSION, { ...split, ids: [...split.ids, ADDED_SESSION] }, others) ?? 0;
}
