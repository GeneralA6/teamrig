import type { FocusConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import type { TimeZone } from '../core/zone.ts';
import type { DecisionFocus } from '../meeting/decision-order.ts';
import { MeetingStore } from '../meeting/state.ts';
import type { Task } from '../register/fold.ts';
import { TaskTree, type TasksElsewhere, type TreeRanking } from '../register/tree.ts';
import { decisionBatch, type BatchConfig, type BatchRegister, type DecisionBatch } from './batch.ts';
import { askedAtOf, AskedStore } from './store.ts';

/** One register whose waits on the owner a team's batch holds: the team's own, or that of a team under it (T1018). */
export interface DecisionRegister {
  /** The team, for a register under the team's own; undefined for its own. */
  readonly team: string | undefined;
  readonly tasks: ReadonlyMap<string, Task>;
  /** The register's marker for the owner (`register.ownerSource`). */
  readonly ownerMarker: string;
  /** Whether a wait on the owner needs its decision card to be asked (`register.requireDecisionCard`). */
  readonly requireGate: boolean;
  /** The register team's clock, which its tasks' dues are on. */
  readonly zone: TimeZone;
  /** The tasks the tree's other registers hold, which a wait on one of them is judged against. */
  readonly elsewhere: TasksElsewhere;
  /** What ranks the register's tasks, so the batch asks them in plan order. */
  readonly ranking: TreeRanking;
  /** The register team's `focus` classes, which say whether a wait frees only Improvements work. */
  readonly focus: DecisionFocus;
}

/** The keys of the team's config its batch reads: its batch times and the weekday of its Improvements batch. */
export interface TeamDecisionsConfig {
  readonly decisions: BatchConfig;
  readonly focus: Pick<FocusConfig, 'improvementsDay'>;
}

/** The team's own register first, then those of the teams under it. */
export type DecisionRegisters = readonly [DecisionRegister, ...DecisionRegister[]];

/**
 * A team's batch of the owner's decisions now: the waits on the owner of its own register and of the registers under
 * it, each with its effective dues on its own team's clock, judged with the tasks the tree's other registers hold,
 * against the batches the team's lead asked, its weekly waits on the team's Improvements day.
 */
export async function teamDecisions(
  files: Files,
  paths: Pick<TeamPaths, 'decisionsAsked' | 'meeting'>,
  config: TeamDecisionsConfig,
  registers: DecisionRegisters,
  now: number,
): Promise<DecisionBatch> {
  const [asked, meeting] = await Promise.all([new AskedStore(files, paths.decisionsAsked).read(), new MeetingStore(files, paths.meeting).read()]);
  return decisionBatch({
    registers: registers.map((register) => batchRegisterOf(register, now)),
    now,
    askedAt: askedAtOf(asked, meeting),
    config: config.decisions,
    improvementsDay: config.focus.improvementsDay,
  });
}

function batchRegisterOf({ team, tasks, ownerMarker, requireGate, zone, elsewhere, ranking, focus }: DecisionRegister, now: number): BatchRegister {
  return { team, tasks: tasks.values(), tree: new TaskTree(tasks, new Date(now), zone, undefined, elsewhere, ranking), ownerMarker, requireGate, focus };
}
