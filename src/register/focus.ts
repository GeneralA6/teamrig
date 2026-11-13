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
 * A goal and every goal up its parent chain, nearest first, each with its tag; it ends at a tag the team holds no goal
 * for. A chain is walked once per goal, so a damaged file's loop cannot hang it.
 */
export function goalChain<G extends Pick<Goal, 'parent'>>(tag: string, goals: ReadonlyMap<string, G>): (readonly [string, G])[] {
  const chain: (readonly [string, G])[] = [];
  const walked = new Set<string>();
  for (let at: string | null = tag; at !== null && !walked.has(at); ) {
    walked.add(at);
    const goal = goals.get(at);
    if (goal === undefined) {
      break;
    }
    chain.push([at, goal]);
    at = goal.parent;
  }
  return chain;
}

/**
 * The goal that gives a task its best (lowest) rank (T2083): over each goal it names and every goal up that goal's
 * parent chain, so a task on an unranked key result takes its objective's rank, and names that objective. Null when
 * none of them is ranked, or the task names no goal the team holds.
 */
export function servedGoalOf(task: Pick<TaskFields, 'goals'>, goals: ReadonlyMap<string, RankedGoal>): ServedGoal | null {
  let best: ServedGoal | null = null;
  for (const tag of task.goals) {
    for (const [at, goal] of goalChain(tag, goals)) {
      if (goal.rank !== null && (best === null || goal.rank < best.rank)) {
        best = { tag: at, rank: goal.rank };
      }
    }
  }
  return best;
}

/** The best rank a task serves, as `servedGoalOf` finds it; null: none. */
export function rankOf(task: Pick<TaskFields, 'goals'>, goals: ReadonlyMap<string, RankedGoal>): number | null {
  return servedGoalOf(task, goals)?.rank ?? null;
}

/** What prepStanding reads of a goal: its rank chain and its open slice. */
export type SlicedGoal = RankedGoal & Pick<Goal, 'slice'>;

/** No goal records: no rank, no slice, so no prep marker stands near. */
export const NO_SLICED_GOALS: ReadonlyMap<string, SlicedGoal> = new Map();

/**
 * Where a task's prep marker stands (T2453): `near` while the goal it prepares is ranked (itself or up its parent
 * chain, as servedGoalOf reads it), has a slice open, and the marked slice is that one or the next; then the task, a
 * design, study or prep plan, runs outside the slice cap. `lapsed` otherwise: the goal moved past the slice, opened
 * none, lost its rank or is gone, and the task gets the treatment of any other. Null for a task with no marker. Pure,
 * so the CLI and the pane read a marker the same way.
 */
export function prepStanding(task: Pick<TaskFields, 'prepares'>, goals: ReadonlyMap<string, SlicedGoal>): PrepStanding | null {
  return prepRead(task, goals)?.standing ?? null;
}

/** A marked task's standing: `near`, outside the slice cap, or `lapsed`, treated as any other. */
export type PrepStanding = 'near' | 'lapsed';

/** A marker's standing ({@link prepStanding}), with why a lapsed one lapsed: the words of check's PREP-LAPSED flag. */
export type PrepRead = { readonly standing: 'near' } | { readonly standing: 'lapsed'; readonly why: string };

/** {@link prepStanding}, telling a lapsed marker's owner what moved, so it knows to re-mark the task or drop the marker. */
export function prepRead(task: Pick<TaskFields, 'prepares'>, goals: ReadonlyMap<string, SlicedGoal>): PrepRead | null {
  const { prepares } = task;
  if (prepares === null) {
    return null;
  }
  const { goal, slice } = prepares;
  const marker = `prepares ${goal}:${slice}, goal ${goal}`;
  if (servedGoalOf({ goals: [goal] }, goals) === null) {
    return { standing: 'lapsed', why: `${marker} is not ranked` };
  }
  const open = goals.get(goal)?.slice ?? null;
  if (open === null) {
    return { standing: 'lapsed', why: `${marker} has no slice open` };
  }
  return slice === open || slice === open + 1 ? { standing: 'near' } : { standing: 'lapsed', why: `${marker} is on slice ${open}` };
}
