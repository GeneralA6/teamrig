import { formatAddress } from "../core/address.js";
const REACHES = { ok: true };
export function reachOf(tree, from, to, leader) {
    if (from.team === to.team) {
        return REACHES;
    }
    const leadsFrom = tree.leadOf(from.team) === from.id;
    const toLead = tree.leadOf(to.team) === to.id;
    if (leadsFrom && toLead && (tree.parentOf(from.team) === to.team || tree.parentOf(to.team) === from.team)) {
        return REACHES;
    }
    const sender = formatAddress(from);
    const target = formatAddress(to);
    if (!leadsFrom) {
        const via = leader === undefined ? '' : ` (${formatAddress({ team: from.team, id: leader })})`;
        return { ok: false, problem: `${sender} may write to its own team only, and ${target} is not on it: escalate through your lead${via}` };
    }
    return {
        ok: false,
        problem: `${sender} may write to its own team, its parent team's lead and its child teams' leads, and ${target} is none of them: escalate through your lead to go up the tree, or through a child team's lead to go down`,
    };
}
