import { LeadTree } from "../config/lead-tree.js";
import { splitAddress } from "../core/address.js";
import { ID_PATTERN, NAME_PATTERN } from "../core/ids.js";
const GROUP_PREFIX = 'group:';
const TEAM_PREFIX = 'team:';
const TREE_LEADS = 'tree:leads';
function toItemOf(text) {
    if (text === 'all' || text === 'leads') {
        return { kind: text };
    }
    if (text === TREE_LEADS) {
        return { kind: 'tree-leads' };
    }
    if (text.startsWith(GROUP_PREFIX)) {
        const leader = text.slice(GROUP_PREFIX.length);
        return NAME_PATTERN.test(leader) ? { kind: 'group', leader } : undefined;
    }
    if (text.startsWith(TEAM_PREFIX)) {
        const team = text.slice(TEAM_PREFIX.length);
        return ID_PATTERN.test(team) ? { kind: 'team', team } : undefined;
    }
    const address = splitAddress(text);
    return address === undefined ? undefined : { kind: 'session', address };
}
/** The items of a `--to` value in the order given; undefined when any item is empty or not one of the forms. */
export function parseTo(text) {
    const items = [];
    for (const part of text.split(',')) {
        const item = toItemOf(part);
        if (item === undefined) {
            return undefined;
        }
        items.push(item);
    }
    return items;
}
/**
 * The sessions a group names on the sender's team, in config order, the sender left out: `all` every session,
 * `leads` the lead and every sub-lead, `group:<leader>` the leader and every session under it at any depth.
 */
export function groupIds(config, group, sender) {
    const tree = new LeadTree(config);
    if (group.kind === 'group' && !tree.isLeader(group.leader)) {
        return { ok: false, problem: `${group.leader} leads no session: group:<leader> takes the lead or a sub-lead` };
    }
    const ids = group.kind === 'all'
        ? config.sessions
        : group.kind === 'leads'
            ? config.sessions.filter((id) => tree.isLeader(id))
            : config.sessions.filter((id) => id === group.leader || tree.leads(group.leader, id));
    return { ok: true, ids: ids.filter((id) => id !== sender) };
}
/**
 * Every team's lead in the tree `team` hangs in, as `{ team, id }`, the root first, then depth first; undefined when
 * the parents above `team` go round a loop, so the tree has no root to start from.
 */
export function treeLeadsOf(tree, team) {
    const root = tree.rootOf(team);
    if (root === undefined) {
        return undefined;
    }
    return tree.walk(root).flatMap((step) => {
        const id = tree.leadOf(step.team);
        return id === undefined ? [] : [{ team: step.team, id }];
    });
}
