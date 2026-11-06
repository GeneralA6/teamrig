import type { FocusConfig } from '../config/types.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { classOf, servedGoalOf, type RankedGoal } from './focus.ts';
import type { Task } from './fold.ts';
import type { SizeFacts } from './score.ts';
import { quantile } from './stats.ts';
import type { TreeRanking, TreeTask } from './tree.ts';

/**
 * The one builder of a tree's ranking (T2076), for the CLI and the pane alike, so a task scores the same in both. Pure:
 * the caller reads the config, the goals and the spend, and hands them in.
 */

/** The `focus` keys a ranking reads. */
export type RankingFocus = Pick<FocusConfig, 'defaultClass' | 'roadmapClass' | 'maintenanceClass' | 'score' | 'expedite'>;

/** What is known of a task's size, as a ranking reads it. */
export type Sizing = (task: TreeTask) => SizeFacts;

export interface RankingInput {
  readonly focus: RankingFocus;
  /** The `source` of a task the owner ordered (`register.ownerSource`). */
  readonly ownerSource: string;
  readonly goals: ReadonlyMap<string, RankedGoal>;
  readonly sizing: Sizing;
}

/** How long a finished task measures its like tasks. The contract holds no config key for it (T2076 design section 3). */
const LIKE_WINDOW_DAYS = 14;

/** The class of a row, which may not carry one. */
function rowClass(task: Pick<TreeTask, 'workClass'>, focus: Pick<FocusConfig, 'defaultClass'>): string {
  return classOf({ workClass: task.workClass ?? null }, focus);
}

/** The ranking of a team's tree. */
export function treeRanking({ focus, ownerSource, goals, sizing }: RankingInput): TreeRanking {
  return {
    focus,
    ownerSource,
    classOf: (task) => rowClass(task, focus),
    goalOf: (task) => servedGoalOf({ goals: task.goals ?? [] }, goals),
    sizingOf: sizing,
  };
}

/** Sizing by a task's own size alone, for a reader with no spend to read: an unsized task takes the default size. */
export function ownSizing(task: Pick<TreeTask, 'size'>): SizeFacts {
  return { size: task.size ?? null, spentPct: 0, likeMedianPct: undefined };
}

/** Which tasks are alike: same class and type. */
function likeKey(task: Pick<TreeTask, 'workClass' | 'type'>, focus: Pick<FocusConfig, 'defaultClass'>): string {
  return `${rowClass(task, focus)}\n${task.type ?? ''}`;
}

/** What {@link likeSizing} reads of a task it measures others by. */
export type LikeTask = Pick<Task, 'id' | 'status' | 'statusAt' | 'workClass' | 'type'>;

/**
 * The median spend per kind of task, of those done inside the window. A dropped task is left out, as its spend is no
 * size of finished work, and so is one with no spend: 0 means unmetered, not free, and a median of 0 falls to the floor
 * and multiplies a score. The meter keeps 8 days, so a task done before them reads 0 and leaves too, and one started
 * before them reads short; a compaction retires only what the meter has already lost (RETAIN_DAYS).
 */
function likeMedians(tasks: Iterable<LikeTask>, focus: Pick<FocusConfig, 'defaultClass'>, spentOf: (id: string) => number, now: number): Map<string, number> {
  const since = now - LIKE_WINDOW_DAYS * MS_PER_DAY;
  const spends = new Map<string, number[]>();
  for (const task of tasks) {
    const spent = task.status === 'done' && Date.parse(task.statusAt) >= since ? spentOf(task.id) : 0;
    if (spent > 0) {
      const key = likeKey(task, focus);
      spends.set(key, [...(spends.get(key) ?? []), spent]);
    }
  }
  const medians = new Map<string, number>();
  for (const [key, spent] of spends) {
    const median = quantile([...spent].sort((a, b) => a - b), 0.5);
    if (median !== null) {
      medians.set(key, median);
    }
  }
  return medians;
}

/** A read of a task's spend: from its size base, or its whole metered cost with a null base. */
export type SpendKey = Pick<Task, 'id' | 'sizeBase'>;

/**
 * Sizing by a task's size, its spend, and the spend of like tasks, each in percent of the week. `spentOf` gives what a
 * task cost past a base, 0 when none is known. A sized task counts from its base, as a size set on a started task is
 * what was left then; a like task counts in full, as it is measured by all it took. The medians are read once here, not
 * per task.
 */
export function likeSizing(tasks: Iterable<LikeTask>, focus: Pick<FocusConfig, 'defaultClass'>, spentOf: (task: SpendKey) => number, now: number): Sizing {
  const medians = likeMedians(tasks, focus, (id) => spentOf({ id, sizeBase: null }), now);
  return (task) => ({ size: task.size ?? null, spentPct: spentOf({ id: task.id, sizeBase: task.sizeBase ?? null }), likeMedianPct: medians.get(likeKey(task, focus)) });
}
