import { roleHolderOf, type Role } from '../config/roster.ts';
import type { KitConfig } from '../config/types.ts';

/** The roles whose holder a short day never pauses: the lead leads the cut, the coordinator owner keeps the fleet up. */
const KEPT_ROLES: readonly Role[] = ['lead', 'coordinatorOwner'];

/**
 * The sessions of `team` (its roster `ids`) a short day may pause: none while its `budget.pauseByPriority` is off,
 * else all but the holders of the kept roles that the team holds itself (a `<team>/<id>` holder is a team above's).
 */
export function pausableOf(config: Pick<KitConfig, 'budget' | 'roles'>, team: string, ids: readonly string[]): ReadonlySet<string> {
  if (!config.budget.pauseByPriority) {
    return new Set();
  }
  const kept = new Set<string>();
  for (const role of KEPT_ROLES) {
    const holder = roleHolderOf(config.roles, role, team);
    if (holder !== undefined && holder.team === team) {
      kept.add(holder.id);
    }
  }
  return new Set(ids.filter((id) => !kept.has(id)));
}
