import type { KitConfig } from '../config/types.ts';
import type { SessionAddress } from '../core/address.ts';
import type { TeamPaths } from '../core/home.ts';
import type { DecisionBatch } from '../decisions/batch.ts';
import { teamDecisions, type DecisionRegister } from '../decisions/team.ts';
import type { Task } from '../register/fold.ts';
import type { TasksElsewhere, TreeRanking } from '../register/tree.ts';
import { teamZone } from './kit.ts';
import { subtreeOf, type RolledTeam } from './roll-up.ts';
import type { CliRuntime } from './runtime.ts';
import type { KitTree } from './tree.ts';

/**
 * A team's register as the owner's batch reads it: the team, its config and folder, its tasks as read or just written,
 * and the tasks the tree's other registers hold.
 */
export interface BatchedTeam {
  readonly team: string;
  readonly config: KitConfig;
  readonly paths: TeamPaths;
  readonly tasks: ReadonlyMap<string, Task>;
  readonly elsewhere: TasksElsewhere;
  readonly ranking: TreeRanking;
}

/** The batch of the owner's decisions that holds a team's waits, and who asks it when the team's own lead does not. */
export interface OwnerBatch {
  readonly batch: DecisionBatch;
  /** For a child team, the lead at its tree's root (TeamTree.ownerLeadAbove); undefined for a root team, whose own lead asks it. */
  readonly askedBy: SessionAddress | undefined;
}

/**
 * The batch of the owner's decisions that holds team `own`'s waits on the owner (T1018): the one the lead at its tree's
 * root asks, over the root's register and every register under it, depth-first (subtreeOf), each on its own team's
 * clock, against the batches the root's lead asked and on the root's batch times. `own` is taken as given, a register
 * just written say; every other register is read without its lock. With the root not loaded, the batch is `own`'s and
 * its subtree's.
 */
export async function ownerBatchOf(runtime: CliRuntime, own: BatchedTeam, loaded: KitTree, now: number): Promise<OwnerBatch> {
  const askedBy = loaded.tree.ownerLeadAbove(own.team);
  const root = askedBy === undefined ? undefined : loaded.teams.get(askedBy.team);
  const top = root ?? loaded.teams.get(own.team);
  const rolled = top === undefined ? [] : (await subtreeOf(runtime, top, loaded)).teams;
  const [first = own, ...rest] = rolled.map((team) => (team.team === own.team ? own : batchedOf(team)));
  const registers: DecisionRegister[] = rest.map((team) => registerOf(runtime, team, team.team));
  const batch = await teamDecisions(runtime.files, first.paths, first.config, [registerOf(runtime, first, undefined), ...registers], now);
  return { batch, askedBy };
}

function batchedOf({ team, config, paths, snapshot, elsewhere, ranking }: RolledTeam): BatchedTeam {
  return { team, config, paths, tasks: snapshot.state.tasks, elsewhere, ranking };
}

/** A register of the batch, labelled with its team, `label`, unless it is the batch's own. */
function registerOf(runtime: CliRuntime, { config, tasks, elsewhere, ranking }: BatchedTeam, label: string | undefined): DecisionRegister {
  return { team: label, tasks, ownerMarker: config.register.ownerSource, requireGate: config.register.requireDecisionCard, zone: teamZone(config, runtime), elsewhere, ranking };
}
