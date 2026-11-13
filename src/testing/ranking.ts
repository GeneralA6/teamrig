import { MS_PER_DAY } from '../core/time.ts';
import type { PrepRead } from '../register/focus.ts';
import type { Task } from '../register/fold.ts';
import type { ParkFocus, ParkRules } from '../register/park.ts';
import { ownSizing } from '../register/ranking.ts';
import type { ScoreFocus } from '../register/score.ts';
import type { ServedGoal, TreeRanking } from '../register/tree.ts';

/** A team's `focus`, as far as a score and the park rule read it, with round weights a test can add up by hand. */
export const TEST_FOCUS: ScoreFocus & ParkFocus = {
  roadmapClass: 'Roadmap',
  maintenanceClass: 'Maintenance',
  parkAfterDays: 14,
  score: {
    rankValues: [20, 16, 12, 8, 4],
    roadmapUnranked: 3,
    maintenanceValue: 10,
    maintenanceBug: 4,
    maintenanceCritical: 10,
    improvementsValue: 1,
    overdueValue: 8,
    dueSoonValue: 4,
    dueSoonDays: 3,
    unblocksShare: 0.5,
    ownerOrderValues: [12, 6, 0, 0, 0],
    defaultSizePct: 0.3,
    minSizePct: 0.05,
  },
  expedite: { critical: true, ownerP1: true },
};

/** The source of a task the owner ordered, in {@link testRanking}. */
export const TEST_OWNER_SOURCE = 'owner';

/** The park rule of {@link TEST_FOCUS}, for the wake's reads. */
export const TEST_PARKING: ParkRules = { focus: TEST_FOCUS, ownerSource: TEST_OWNER_SOURCE };

/** A task the rule takes at `now`: classed Improvements, quiet past `parkAfterDays`, never touched by its owner. */
export function parkedFacts(now: number): Pick<Task, 'workClass' | 'updatedAt' | 'ownerSeenAt'> {
  return { workClass: 'Improvements', updatedAt: new Date(now - (TEST_FOCUS.parkAfterDays + 6) * MS_PER_DAY).toISOString(), ownerSeenAt: null };
}

/** What {@link testRanking} knows of tasks by id; any other task is unclassed and serves no goal. */
export interface TestRankingFacts {
  readonly classes?: Readonly<Record<string, string>>;
  readonly goals?: Readonly<Record<string, ServedGoal>>;
  /** Where each task's prep marker stands; any other task has no marker. */
  readonly preps?: Readonly<Record<string, PrepRead>>;
}

/** A ranking over fixed facts: a task with no class counts as Improvements, and only its own `size` sizes it. */
export function testRanking({ classes = {}, goals = {}, preps = {} }: TestRankingFacts = {}): TreeRanking {
  return {
    focus: TEST_FOCUS,
    ownerSource: TEST_OWNER_SOURCE,
    classOf: (task) => classes[task.id] ?? 'Improvements',
    goalOf: (task) => goals[task.id] ?? null,
    prepOf: (task) => preps[task.id] ?? null,
    sizingOf: ownSizing,
  };
}
