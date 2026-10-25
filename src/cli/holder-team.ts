import type { KitConfig } from '../config/types.ts';
import { formatAddress, type SessionAddress } from '../core/address.ts';
import { openKit, type Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';

/** A team as a command opened it: its folder and paths, and its config. */
export interface OpenTeam {
  readonly kit: Kit;
  readonly config: KitConfig;
}

/** The team a role holder sits on, as a line posted to the holder reaches it. */
export interface HolderTeam extends OpenTeam {
  /** How the holder's inbox names a sender of the posting team: its bare id at home, `<team>/<id>` on a team above. */
  sender(id: string): string;
}

export type HolderTeamResult = { readonly ok: true; readonly holder: HolderTeam } | { readonly ok: false; readonly problem: string };

/**
 * The team of a role's holder (roleHolderOf): the posting team itself, or a team above it that a child team leaves
 * the role to (T1143); a team above with no config to read gives the problem instead, for the poster to warn about.
 */
export async function holderTeamOf(runtime: CliRuntime, own: OpenTeam, holder: SessionAddress): Promise<HolderTeamResult> {
  const team = own.kit.paths.team;
  if (holder.team === team) {
    return { ok: true, holder: { kit: own.kit, config: own.config, sender: (id) => id } };
  }
  const kit = await openKit(runtime, holder.team);
  if (kit.load.status !== 'loaded') {
    return { ok: false, problem: `no team ${holder.team} with a config in this kit home` };
  }
  return { ok: true, holder: { kit, config: kit.load.config, sender: (id) => formatAddress({ team, id }) } };
}
