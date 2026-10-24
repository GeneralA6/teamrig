import { LeadTree } from '../config/lead-tree.ts';
import type { KitConfig } from '../config/types.ts';
import { splitAddress, type AddressText } from '../core/address.ts';
import { NAME_PATTERN } from '../core/ids.ts';

/**
 * One comma-separated item of `inbox add --to` (T1134): a group of the sender's own team, or one session as typed. A
 * bare `all` or `leads` is the group; `<team>/<id>` always names one session, so a session called `all` stays
 * reachable as `<its team>/all`.
 */
export type ToItem =
  | { readonly kind: 'all' }
  | { readonly kind: 'leads' }
  | { readonly kind: 'group'; readonly leader: string }
  | { readonly kind: 'session'; readonly address: AddressText };

const GROUP_PREFIX = 'group:';

function toItemOf(text: string): ToItem | undefined {
  if (text === 'all' || text === 'leads') {
    return { kind: text };
  }
  if (text.startsWith(GROUP_PREFIX)) {
    const leader = text.slice(GROUP_PREFIX.length);
    return NAME_PATTERN.test(leader) ? { kind: 'group', leader } : undefined;
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
