import type { FocusConfig } from '../config/types.ts';
import type { TaskFields } from './events.ts';
import type { Goal } from './goals.ts';
import type { ServedGoal } from './tree.ts';

/**
 * The work class a task counts as (T2076): its own `workClass`, else the team's `focus.defaultClass`, so a task no one
 * classed ranks with team tooling, last. Pure, so the CLI and the pane read a class the same way.
 */
export function classOf(task: Pick<TaskFields, 'workClass'>, focus: Pick<FocusConfig, 'defaultClass'>): string {
  return task.workClass ?? focus.defaultClass;
}

/** What rankOf reads of a goal. */
export type RankedGoal = Pick<Goal, 'parent' | 'rank'>;

/**
 * The goal that gives a task its best (lowest) rank (T2083): over each goal it names and every goal up that goal's
 * parent chain, so a task on an unranked key result takes its objective's rank, and names that objective. Null when
 * none of them is ranked, or the task names no goal the team holds. A chain is walked once per goal, so a damaged
 * file's loop cannot hang it.
 */
export function servedGoalOf(task: Pick<TaskFields, 'goals'>, goals: ReadonlyMap<string, RankedGoal>): ServedGoal | null {
  let best: ServedGoal | null = null;
  for (const tag of task.goals) {
    const walked = new Set<string>();
    for (let at: string | null = tag; at !== null && !walked.has(at); ) {
      walked.add(at);
      const goal = goals.get(at);
      if (goal === undefined) {
        break;
      }
      if (goal.rank !== null && (best === null || goal.rank < best.rank)) {
        best = { tag: at, rank: goal.rank };
      }
      at = goal.parent;
    }
  }
  return best;
}

/** The best rank a task serves, as `servedGoalOf` finds it; null: none. */
export function rankOf(task: Pick<TaskFields, 'goals'>, goals: ReadonlyMap<string, RankedGoal>): number | null {
  return servedGoalOf(task, goals)?.rank ?? null;
}
