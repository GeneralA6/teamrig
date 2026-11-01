import type { ConfigLoad } from '../../config/load.ts';
import { isRecord, stringField } from '../../core/guards.ts';
import { resolveTeam, type TeamResolution } from '../../core/team.ts';
import { openKit, teamFolders, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';

/** The payload's folder first: Claude Code may start the hook process somewhere else. */
export function hookTeam(payload: unknown, runtime: CliRuntime): Promise<TeamResolution> {
  const cwd = isRecord(payload) ? stringField(payload, 'cwd') : undefined;
  return resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [cwd, runtime.cwd]));
}

/** The team a guard hook runs in, and its config load; either is undefined when it could not be opened. */
export interface GuardLoad {
  readonly kit: Kit | undefined;
  readonly load: ConfigLoad | undefined;
}

/**
 * The config a guard hook reads, or undefined outside a team's projects, where the guard prints nothing. A broken
 * pointer, or a config that cannot even be opened, gives no load, so the guard keeps its defaults: neither turns it off.
 */
export async function guardLoadOf(payload: unknown, runtime: CliRuntime): Promise<GuardLoad | undefined> {
  const found = await hookTeam(payload, runtime);
  if (found.kind === 'none') {
    return undefined;
  }
  const kit = found.kind === 'team' ? await openKit(runtime, found.team).catch(() => undefined) : undefined;
  return { kit, load: kit?.load };
}
