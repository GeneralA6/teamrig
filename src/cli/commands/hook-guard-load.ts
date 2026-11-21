import type { ConfigLoad } from '../../config/load.ts';
import { resolveTeam, type TeamResolution } from '../../core/team.ts';
import { openKit, teamFolders, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';

/**
 * The team of the folder a hook's call runs in. `folder` is the one the hook event names, undefined when the input
 * named none; it comes first, since the host may start the hook process somewhere else.
 */
export function hookTeam(folder: string | undefined, runtime: CliRuntime): Promise<TeamResolution> {
  return resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [folder, runtime.cwd]));
}

/** The team a guard hook runs in, and its config load; either is undefined when it could not be opened. */
export interface GuardLoad {
  readonly kit: Kit | undefined;
  readonly load: ConfigLoad | undefined;
}

/**
 * The config a guard hook reads for a call in `folder` (see `hookTeam`), or undefined outside a team's projects, where
 * the guard prints nothing. A broken pointer, or a config that cannot even be opened, gives no load, so the guard keeps
 * its defaults: neither turns it off.
 */
export async function guardLoadOf(folder: string | undefined, runtime: CliRuntime): Promise<GuardLoad | undefined> {
  const found = await hookTeam(folder, runtime);
  if (found.kind === 'none') {
    return undefined;
  }
  const kit = found.kind === 'team' ? await openKit(runtime, found.team).catch(() => undefined) : undefined;
  return { kit, load: kit?.load };
}
