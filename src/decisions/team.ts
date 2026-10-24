import type { DecisionsConfig, RegisterConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import type { TimeZone } from '../core/zone.ts';
import { MeetingStore } from '../meeting/state.ts';
import type { Task } from '../register/fold.ts';
import { NO_TASKS_ELSEWHERE, TaskTree, type TasksElsewhere } from '../register/tree.ts';
import { decisionBatch, type DecisionBatch } from './batch.ts';
import { askedAtOf, AskedStore } from './store.ts';

export interface TeamDecisions {
  readonly batch: DecisionBatch;
  /** The tree the batch was judged on: effective dues and plan order for printing it. */
  readonly tree: TaskTree;
}

/**
 * A team's batch of the owner's decisions now: its register's waits on the owner against the batches the lead asked,
 * their effective dues on the team's clock (`zone`). `elsewhere` holds the tasks of the team tree's other registers,
 * which a wait on one of them is judged against.
 */
export async function teamDecisions(
  files: Files,
  paths: Pick<TeamPaths, 'decisionsAsked' | 'meeting'>,
  config: { readonly decisions: DecisionsConfig; readonly register: Pick<RegisterConfig, 'ownerSource' | 'requireDecisionCard'> },
  tasks: ReadonlyMap<string, Task>,
  now: number,
  zone: TimeZone,
  elsewhere: TasksElsewhere = NO_TASKS_ELSEWHERE,
): Promise<TeamDecisions> {
  const [asked, meeting] = await Promise.all([new AskedStore(files, paths.decisionsAsked).read(), new MeetingStore(files, paths.meeting).read()]);
  const tree = new TaskTree(tasks, new Date(now), zone, undefined, elsewhere);
  const batch = decisionBatch({
    registers: [{ team: undefined, tasks: tasks.values(), tree, ownerMarker: config.register.ownerSource, requireGate: config.register.requireDecisionCard }],
    now,
    askedAt: askedAtOf(asked, meeting),
    config: config.decisions,
  });
  return { batch, tree };
}
