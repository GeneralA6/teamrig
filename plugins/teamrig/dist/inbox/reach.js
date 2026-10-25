import { formatAddress } from "../core/address.js";
const REACHES = { ok: true };
export function reachOf(tree, from, to) {
    if (from.team === to.team || tree.sameTree(from.team, to.team)) {
        return REACHES;
    }
    return { ok: false, problem: `${formatAddress(from)} and ${formatAddress(to)} are in separate trees of teams: an inbox line reaches only a session of its own tree` };
}
