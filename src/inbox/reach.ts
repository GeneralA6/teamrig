import { formatAddress, type SessionAddress } from '../core/address.ts';
import type { TeamTree } from '../config/tree.ts';

/**
 * Who may leave a line in whose inbox across teams (T1149): any session of a tree of teams reaches any session of
 * that tree, members and sibling teams included, with no relay through the leads between them. A line wakes no one,
 * and the register's asks, not the inbox, keep the work order with each receiver's leader. Teams of separate trees
 * never reach each other.
 */
export type Reach = { readonly ok: true } | { readonly ok: false; readonly problem: string };

const REACHES: Reach = { ok: true };

export function reachOf(tree: TeamTree, from: SessionAddress, to: SessionAddress): Reach {
  if (from.team === to.team || tree.sameTree(from.team, to.team)) {
    return REACHES;
  }
  return { ok: false, problem: `${formatAddress(from)} and ${formatAddress(to)} are in separate trees of teams: an inbox line reaches only a session of its own tree` };
}
