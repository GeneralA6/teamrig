import { LeadTree } from '../config/lead-tree.ts';
import type { TeamTree } from '../config/tree.ts';
import type { KitConfig } from '../config/types.ts';
import { formatAddress, splitAddress, type AddressText, type SessionAddress } from '../core/address.ts';
import { ID_PATTERN, NAME_PATTERN } from '../core/ids.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES, TASK_ID } from '../register/model.ts';

/**
 * One comma-separated item of `inbox add --to` (T1134): a group of the sender's own team, a group of its tree (T1150:
 * `team:<team>` every session of that team, `tree:leads` every team's lead; T1151: `task:T<n>` the sessions working a
 * task, see {@link taskGroupOf}), or one session as typed. A bare `all` or
 * `leads` is the group; `<team>/<id>` always names one session, so a session called `all` stays reachable as
 * `<its team>/all`.
 */
export type ToItem =
  | { readonly kind: 'all' }
  | { readonly kind: 'leads' }
  | { readonly kind: 'group'; readonly leader: string }
  | { readonly kind: 'team'; readonly team: string }
  | { readonly kind: 'tree-leads' }
  | { readonly kind: 'task'; readonly id: string }
  | { readonly kind: 'session'; readonly address: AddressText };

const GROUP_PREFIX = 'group:';
const TEAM_PREFIX = 'team:';
const TASK_PREFIX = 'task:';
const TREE_LEADS = 'tree:leads';

function toItemOf(text: string): ToItem | undefined {
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
export function parseTo(text: string): ToItem[] | undefined {
  const items: ToItem[] = [];
  for (const part of text.split(',')) {
    const item = toItemOf(part);
    if (item === undefined) {
      return undefined;
    }
    items.push(item);
  }
  return items;
}

/** A group with its leader already resolved to an id. */
export type Group = { readonly kind: 'all' } | { readonly kind: 'leads' } | { readonly kind: 'group'; readonly leader: string };

export type GroupIds = { readonly ok: true; readonly ids: string[] } | { readonly ok: false; readonly problem: string };

/**
 * The sessions a group names on the sender's team, in config order, the sender left out: `all` every session,
 * `leads` the lead and every sub-lead, `group:<leader>` the leader and every session under it at any depth.
 */
export function groupIds(config: Pick<KitConfig, 'sessions' | 'roles' | 'leads'>, group: Group, sender: string): GroupIds {
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
export function treeLeadsOf(tree: TeamTree, team: string): SessionAddress[] | undefined {
  const root = tree.rootOf(team);
  if (root === undefined) {
    return undefined;
  }
  return tree.walk(root).flatMap((step) => {
    const id = tree.leadOf(step.team);
    return id === undefined ? [] : [{ team: step.team, id }];
  });
}

/** One register of a team tree as `task:T<n>` reads it: its team and its tasks by id. */
export interface RegisterTasks {
  readonly team: string;
  readonly tasks: ReadonlyMap<string, Task>;
}

export type TaskGroup = { readonly ok: true; readonly sessions: SessionAddress[] } | { readonly ok: false; readonly problem: string };

/** The team whose task `reader` reads as `id` (T1139): its own when its register holds one, else the first to hold one. */
function holderOf(registers: readonly RegisterTasks[], reader: string, id: string): string | undefined {
  const own = registers.find((register) => register.team === reader);
  return own?.tasks.has(id) === true ? reader : registers.find((register) => register.tasks.has(id))?.team;
}

/**
 * `task:T<n>` (T1151), from team `reader` of a tree whose registers are given in its walk order: the owner of the task
 * the reader reads as T<n>, then the owner of each active task of the tree whose ref is T<n> and names that same task
 * as its own register reads it, register by register, each session once. Shared work is a task of the owning team
 * plus a task per contributing team whose ref names it, so the address reaches everyone working it.
 */
export function taskGroupOf(registers: readonly RegisterTasks[], reader: string, id: string): TaskGroup {
  const holder = holderOf(registers, reader, id);
  const task = registers.find((register) => register.team === holder)?.tasks.get(id);
  if (holder === undefined || task === undefined) {
    return { ok: false, problem: `no task ${id} in a register of the tree of teams ${reader} is in` };
  }
  const linked = registers.flatMap((register) =>
    [...register.tasks.values()]
      .filter((other) => other.ref === id && ACTIVE_STATUSES.includes(other.status) && holderOf(registers, register.team, id) === holder)
      .map((other) => ({ team: register.team, id: other.owner })),
  );
  const sessions = new Map<string, SessionAddress>();
  for (const session of [{ team: holder, id: task.owner }, ...linked]) {
    if (!sessions.has(formatAddress(session))) {
      sessions.set(formatAddress(session), session);
    }
  }
  return { ok: true, sessions: [...sessions.values()] };
}
