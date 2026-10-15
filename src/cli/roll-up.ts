import type { Roster } from '../config/roster.ts';
import type { KitConfig } from '../config/types.ts';
import { formatAddress } from '../core/address.ts';
import type { TeamPaths } from '../core/home.ts';
import type { RegisterSnapshot } from '../register/snapshot.ts';
import { JsonlEventLog } from '../register/store.ts';
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf } from './kit.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';
import { loadTree, type TreeTeam } from './tree.ts';

/** One team of a roll-up: its id, config, folder and roster, and its register's working set as read. */
export interface RolledTeam {
  readonly team: string;
  readonly config: KitConfig;
  readonly paths: TeamPaths;
  readonly roster: Roster;
  readonly snapshot: RegisterSnapshot;
  /** Reads the register's whole history, for a command the working set cannot serve. */
  readonly history: () => Promise<RegisterSnapshot>;
}

/** The caller's own team, then every team under it, depth-first. */
export interface RollUp {
  readonly own: RolledTeam;
  readonly teams: readonly RolledTeam[];
}

async function rolledOf(runtime: CliRuntime, team: string, { kit, config, roster }: TreeTeam): Promise<RolledTeam> {
  const log = new JsonlEventLog(runtime.files, kit.paths.events);
  return { team, config, paths: kit.paths, roster, snapshot: await log.read(), history: () => log.readHistory() };
}

/**
 * The registers behind `list|check|plan --tree`: the caller's team and the teams under it. Only the
 * team's lead rolls up. Each register is read without its lock, as every read is, so nothing in
 * another team's folder is written.
 */
export async function rollUp(runtime: CliRuntime, caller: string): Promise<RollUp> {
  const { team } = await findTeam(runtime);
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const id = sessionIdOf(await rosterOf(runtime, kit, config), caller);
  const { tree, teams } = await loadTree(runtime);
  const lead = tree.leadOf(team);
  const ownTeam = teams.get(team);
  if (ownTeam === undefined || lead !== id) {
    const named = lead === undefined ? '' : ` (${formatAddress({ team, id: lead })})`;
    throw new RefusedError(`--tree is for the team's lead${named}; ${formatAddress({ team, id })} reads its own team's tasks without it`);
  }
  const order = tree.descendantsOf(team);
  const below = [...teams].filter(([member]) => order.includes(member)).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  const own = await rolledOf(runtime, team, ownTeam);
  const rolled = [own];
  for (const [member, loaded] of below) {
    rolled.push(await rolledOf(runtime, member, loaded));
  }
  return { own, teams: rolled };
}
