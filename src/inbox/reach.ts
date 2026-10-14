import { formatAddress, type SessionAddress } from '../core/address.ts';
import type { TeamTree } from '../config/tree.ts';

/**
 * Who may leave a line in whose inbox across a tree of teams. A member reaches its own team only; a
 * lead also reaches its parent team's lead and its child teams' leads. Anything further goes one
 * lead at a time, so each lead sees what crosses its team's border.
 */
export type Reach = { readonly ok: true } | { readonly ok: false; readonly problem: string };

const REACHES: Reach = { ok: true };

export function reachOf(tree: TeamTree, from: SessionAddress, to: SessionAddress): Reach {
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
    const lead = tree.leadOf(from.team);
    const via = lead === undefined ? '' : ` (${formatAddress({ team: from.team, id: lead })})`;
    return { ok: false, problem: `${sender} may write to its own team only, and ${target} is not on it: escalate through your lead${via}` };
  }
  return {
    ok: false,
    problem: `${sender} may write to its own team, its parent team's lead and its child teams' leads, and ${target} is none of them: escalate through your lead to go up the tree, or through a child team's lead to go down`,
  };
}
