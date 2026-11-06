import type { Roster } from '../config/roster.ts';
import type { KitConfig } from '../config/types.ts';
import { formatAddress, type SessionAddress } from '../core/address.ts';
import type { TeamPaths } from '../core/home.ts';
import type { RegisterSnapshot } from '../register/snapshot.ts';
import { JsonlEventLog } from '../register/store.ts';
import type { TasksElsewhere, TreeRanking } from '../register/tree.ts';
import { findTeam, openKit, requireConfig, rosterOf, sessionIdOf } from './kit.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';
import { teamRanking } from './team-ranking.ts';
import { TreeTasks } from './tree-tasks.ts';
import { loadTree, type KitTree, type TreeTeam } from './tree.ts';

/**
 * One team of a roll-up: its id, config, folder and roster, its register's working set as read, and the tasks the
 * other registers of its tree hold, which a wait on one of them is judged against (T1139).
 */
export interface RolledTeam {
  readonly team: string;
  readonly config: KitConfig;
  readonly paths: TeamPaths;
  readonly roster: Roster;
  readonly snapshot: RegisterSnapshot;
  /** Reads the register's whole history, for a command the working set cannot serve. */
  readonly history: () => Promise<RegisterSnapshot>;
  readonly elsewhere: TasksElsewhere;
  /** The parent team's lead, who approves the team's lead's own work (T1140); undefined on a root team. */
  readonly above: SessionAddress | undefined;
  /** What ranks the team's tasks (team-ranking.ts), for every tree built on this register that sorts or lists. */
  readonly ranking: TreeRanking;
}

type ReadTeam = Omit<RolledTeam, 'elsewhere'>;

/** The caller's own team, then every team under it, depth-first. */
export interface RollUp {
  readonly own: RolledTeam;
  readonly teams: readonly RolledTeam[];
}

async function readOf(runtime: CliRuntime, team: string, { kit, config, roster }: TreeTeam, kitTree: KitTree): Promise<ReadTeam> {
  const log = new JsonlEventLog(runtime.files, kit.paths.events);
  const snapshot = await log.read();
  const ranking = await teamRanking(runtime, kit.paths, config, snapshot.state.tasks.values());
  return { team, config, paths: kit.paths, roster, snapshot, history: () => log.readHistory(), above: kitTree.tree.parentLeadOf(team), ranking };
}

/**
 * The registers of the team `own` and of every team under it in `kitTree`, depth-first, its own first, each with the
 * tasks the others hold. Each is read without its lock, as every read is, so nothing in another team's folder is
 * written, and a register read here is not read again for another team's tasks elsewhere.
 */
export async function subtreeOf(runtime: CliRuntime, own: TreeTeam, kitTree: KitTree): Promise<RollUp> {
  const team = own.kit.paths.team;
  const order = kitTree.tree.descendantsOf(team);
  const below = [...kitTree.teams].filter(([member]) => order.includes(member)).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  const ownRead = await readOf(runtime, team, own, kitTree);
  const belowRead: ReadTeam[] = [];
  for (const [member, loaded] of below) {
    belowRead.push(await readOf(runtime, member, loaded, kitTree));
  }
  const treeTasks = new TreeTasks(runtime, kitTree, new Map([ownRead, ...belowRead].map((read) => [read.team, read.snapshot])));
  const withElsewhere = async (read: ReadTeam): Promise<RolledTeam> => ({ ...read, elsewhere: await treeTasks.elsewhereFor(read.team) });
  const rolledOwn = await withElsewhere(ownRead);
  const rolled = [rolledOwn];
  for (const read of belowRead) {
    rolled.push(await withElsewhere(read));
  }
  return { own: rolledOwn, teams: rolled };
}

/** The registers behind `list|check|plan --tree`: the caller's team and the teams under it (subtreeOf). Only the team's lead rolls up. */
export async function rollUp(runtime: CliRuntime, caller: string): Promise<RollUp> {
  const { team } = await findTeam(runtime);
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const roster = await rosterOf(runtime, kit, config);
  const id = sessionIdOf(roster, caller);
  const kitTree = await loadTree(runtime);
  const lead = kitTree.tree.leadOf(team);
  if (lead !== id) {
    const named = lead === undefined ? '' : ` (${formatAddress({ team, id: lead })})`;
    throw new RefusedError(`--tree is for the team's lead${named}; ${formatAddress({ team, id })} reads its own team's tasks without it`);
  }
  return subtreeOf(runtime, { kit, config, roster }, kitTree);
}
