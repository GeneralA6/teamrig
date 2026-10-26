import { LeadTree } from "../config/lead-tree.js";
import { formatAddress, splitAddress } from "../core/address.js";
import { ID_PATTERN, NAME_PATTERN } from "../core/ids.js";
import { ACTIVE_STATUSES, TASK_ID } from "../register/model.js";
const GROUP_PREFIX = 'group:';
const TEAM_PREFIX = 'team:';
const TASK_PREFIX = 'task:';
const TREE_LEADS = 'tree:leads';
function toItemOf(text) {
    if (text === 'all' || text === 'leads') {
        return { kind: text };
    }
    if (text === TREE_LEADS) {
        return { kind: 'tree-leads' };
    }
    if (text.startsWith(TASK_PREFIX)) {
        const id = text.slice(TASK_PREFIX.length);
        return TASK_ID.test(id) ? { kind: 'task', id } : undefined;
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
/** The team whose task `reader` reads as `id` (T1139): its own when its register holds one, else the first to hold one. */
function holderOf(registers, reader, id) {
    const own = registers.find((register) => register.team === reader);
    return own?.tasks.has(id) === true ? reader : registers.find((register) => register.tasks.has(id))?.team;
}
/**
 * `task:T<n>` (T1151), from team `reader` of a tree whose registers are given in its walk order: the owner of the task
 * the reader reads as T<n>, then the owner of each active task of the tree whose ref is T<n> and names that same task
 * as its own register reads it, register by register, each session once. Shared work is a task of the owning team
 * plus a task per contributing team whose ref names it, so the address reaches everyone working it.
 */
export function taskGroupOf(registers, reader, id) {
    const holder = holderOf(registers, reader, id);
    const task = registers.find((register) => register.team === holder)?.tasks.get(id);
    if (holder === undefined || task === undefined) {
        return { ok: false, problem: `no task ${id} in a register of the tree of teams ${reader} is in` };
    }
    const linked = registers.flatMap((register) => [...register.tasks.values()]
        .filter((other) => other.ref === id && ACTIVE_STATUSES.includes(other.status) && holderOf(registers, register.team, id) === holder)
        .map((other) => ({ team: register.team, id: other.owner })));
    const sessions = new Map();
    for (const session of [{ team: holder, id: task.owner }, ...linked]) {
        if (!sessions.has(formatAddress(session))) {
            sessions.set(formatAddress(session), session);
        }
    }
    return { ok: true, sessions: [...sessions.values()] };
}
