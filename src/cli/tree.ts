import { join, resolve } from 'node:path';
import type { ConfigLoad } from '../config/load.ts';
import type { Roster } from '../config/roster.ts';
import { TeamTree, teamNodeOf } from '../config/tree.ts';
import type { KitConfig } from '../config/types.ts';
import type { SessionAddress } from '../core/address.ts';
import { resolveKitHome, type TeamPaths } from '../core/home.ts';
import { ID_PATTERN } from '../core/ids.ts';
import { openKit, rosterOf, type Kit, type KitReader } from './kit.ts';

/** A team the tree loaded: its folder and paths, its config and its roster with renames applied. */
export interface TreeTeam {
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly roster: Roster;
}

/** A team folder's config that did not load: there is none, or it cannot be read. */
export type LeftOutLoad = Exclude<ConfigLoad, { readonly status: 'loaded' }>;

/** Every team of the kit home with a config, linked by their `team.parent`. */
export interface KitTree {
  readonly tree: TeamTree;
  readonly teams: ReadonlyMap<string, TreeTeam>;
  /**
   * The team folders the tree holds no node for, each with how its config read. Such a team's parent is unknown, so
   * which tree it belongs to is too: a caller that must say what it could not read names every one of them.
   */
  readonly leftOut: ReadonlyMap<string, LeftOutLoad>;
}

/** The folder holding every team's folder, `<kit home>/teams`. */
export function teamsFolderOf(runtime: Pick<KitReader, 'env' | 'userHome'>): string {
  return join(resolveKitHome(runtime.env, runtime.userHome), 'teams');
}

/**
 * Reads every team config under `<kit home>/teams/`, read-only. A folder with no config or one that
 * cannot be read is left out of the tree and kept in `leftOut`: that team's own commands report it, and
 * `doctor` names a parent left out this way as missing.
 */
export async function loadTree(runtime: KitReader): Promise<KitTree> {
  const folders = await runtime.files.list(teamsFolderOf(runtime));
  const teams = new Map<string, TreeTeam>();
  const leftOut = new Map<string, LeftOutLoad>();
  for (const team of folders.filter((folder) => ID_PATTERN.test(folder)).sort()) {
    const kit = await openKit(runtime, team);
    if (kit.load.status === 'loaded') {
      const { config } = kit.load;
      teams.set(team, { kit, config, roster: await rosterOf(runtime, kit, config) });
    } else {
      leftOut.set(team, kit.load);
    }
  }
  const nodes = [...teams].map(([team, { config, roster }]) => teamNodeOf(team, config, roster));
  return { tree: new TeamTree(nodes), teams, leftOut };
}

/**
 * The sessions of the other teams of a team's tree that read its skills folder too: each such team's own `check` lints
 * the skills its sessions own there, so the team's lints leave those out (T1473). A team whose `paths.skills` names
 * another folder never lints this one, so its sessions are not counted.
 */
export function skillOwnersElsewhere(loaded: KitTree, paths: Pick<TeamPaths, 'team' | 'skills'>): Set<string> {
  const { tree, teams } = loaded;
  const shares = ([other, { kit }]: readonly [string, TreeTeam]): boolean =>
    other !== paths.team && tree.sameTree(other, paths.team) && resolve(kit.paths.skills) === resolve(paths.skills);
  return new Set([...teams].filter(shares).flatMap(([, { config }]) => config.sessions));
}

/**
 * The parent team's lead, who approves the team's lead's own work (T1140); undefined for a root team, read without the
 * tree, or for a team whose parent has no config, which `doctor` names.
 */
export async function leadAboveOf(runtime: KitReader, team: string, config: KitConfig): Promise<SessionAddress | undefined> {
  if (config.team?.parent === undefined) {
    return undefined;
  }
  return (await loadTree(runtime)).tree.parentLeadOf(team);
}
