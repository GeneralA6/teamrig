import type { KitConfig } from '../config/types.ts';
import { openKit, type Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';

/** A team's opened kit with its loaded config. */
export interface LoadedTeam {
  readonly kit: Kit;
  readonly config: KitConfig;
}

/**
 * The root of the tree `own` sits in, up its `team.parent` links: the owner meets only the root team's lead, and the
 * root's lead writes the tree's day schedule. Undefined when a config on the way does not load; a loop of parent
 * links ends at the last team before the first one met again.
 */
export async function rootTeamOf(runtime: CliRuntime, own: LoadedTeam): Promise<LoadedTeam | undefined> {
  const seen = new Set<string>([own.kit.paths.team]);
  let current = own;
  for (let parent = own.config.team?.parent; parent !== undefined && !seen.has(parent); parent = current.config.team?.parent) {
    seen.add(parent);
    const kit = await openKit(runtime, parent);
    if (kit.load.status !== 'loaded') {
      return undefined;
    }
    current = { kit, config: kit.load.config };
  }
  return current;
}
