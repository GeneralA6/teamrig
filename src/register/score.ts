import type { FocusConfig, FocusScoreConfig } from '../config/types.ts';
import { MS_PER_DAY } from '../core/time.ts';
import type { ItemType } from './events.ts';

/**
 * A task's WSJF rank (T2076): what a delay costs over the share of the week it takes, so plan order puts the most value
 * per unit of work first, and a band above the score keeps an expedite ahead of every number. Pure: the caller reads the
 * class, goal rank, effective due and spend, so the CLI and the pane score a task the same way.
 */

/** The part of the `focus` config a score reads. A team may rename its classes, so none is spelled here. */
export type ScoreFocus = Pick<FocusConfig, 'roadmapClass' | 'maintenanceClass' | 'score' | 'expedite'>;

/** What a task is worth before any date, need or order: its class, its best goal rank (null: none) and its severity. */
export interface ValueFacts {
  readonly workClass: string;
  readonly rank: number | null;
  readonly type: ItemType | null;
  readonly critical: boolean;
}

/** What is known of a task's size, each in percent of the week; the first that holds a number sizes it. */
export interface SizeFacts {
  readonly size: number | null;
  /** What it spent so far. */
  readonly spentPct: number;
  /** The median spend of like tasks finished lately; undefined: none finished. */
  readonly likeMedianPct: number | undefined;
}

/** Whether an order of the owner's stands behind a task, and at which priority. */
export interface OrderFacts {
  readonly priority: number;
  readonly ownerSourced: boolean;
}

/** All a score reads of one task. */
export interface ScoreFacts extends ValueFacts, OrderFacts {
  /** Its effective due in ms; undefined: none. */
  readonly dueAt: number | undefined;
  /** The best {@link valueOf} among the active tasks that need it; undefined: none does. */
  readonly neededValue: number | undefined;
  readonly sizing: SizeFacts;
}

/** The band a task ranks in before its score: 0 expedite, 1 Roadmap and Maintenance, 2 the rest. */
export type Band = 0 | 1 | 2;

export interface TaskScore {
  readonly band: Band;
  /** Cost of delay over size, to two decimals. */
  readonly score: number;
  readonly costOfDelay: number;
  readonly sizePct: number;
}

/** A task's own value: a Roadmap task's by its goal rank, a Maintenance task's by its severity, any other class's flat. */
export function valueOf(facts: ValueFacts, focus: Pick<ScoreFocus, 'roadmapClass' | 'maintenanceClass' | 'score'>): number {
  const { score } = focus;
  if (facts.workClass === focus.roadmapClass) {
    return facts.rank === null ? score.roadmapUnranked : (score.rankValues[Math.min(facts.rank, score.rankValues.length) - 1] ?? score.roadmapUnranked);
  }
  if (facts.workClass === focus.maintenanceClass) {
    return score.maintenanceValue + (facts.type === 'bug' ? score.maintenanceBug : 0) + (facts.critical ? score.maintenanceCritical : 0);
  }
  return score.improvementsValue;
}

/** What the date adds: the overdue value past the due, the due-soon value up to `dueSoonDays` before it, else nothing. */
export function urgencyOf(dueAt: number | undefined, now: number, score: Pick<FocusScoreConfig, 'overdueValue' | 'dueSoonValue' | 'dueSoonDays'>): number {
  if (dueAt === undefined) {
    return 0;
  }
  if (now > dueAt) {
    return score.overdueValue;
  }
  return dueAt - now <= score.dueSoonDays * MS_PER_DAY ? score.dueSoonValue : 0;
}

/**
 * What the tasks that need it add: a share of the best value among them. A value, never their whole cost of delay, so
 * a chain of needs adds one step and a loop of them cannot recurse.
 */
export function unblocksOf(neededValue: number | undefined, score: Pick<FocusScoreConfig, 'unblocksShare'>): number {
  return neededValue === undefined ? 0 : score.unblocksShare * neededValue;
}

/** The capped override an owner's order adds; every other priority adds nothing. */
export function ownerOrderOf(facts: OrderFacts, score: Pick<FocusScoreConfig, 'ownerOrderValues'>): number {
  return facts.ownerSourced ? (score.ownerOrderValues[facts.priority - 1] ?? 0) : 0;
}

/**
 * The share of the week a score divides by: the task's size; else twice what it spent, a task half done by the only
 * measure there is; else what like tasks took; else the default; never under the floor, so a tiny task cannot outrank
 * everything.
 */
export function sizePctOf(facts: SizeFacts, score: Pick<FocusScoreConfig, 'defaultSizePct' | 'minSizePct'>): number {
  const measured = facts.spentPct > 0 ? facts.spentPct * 2 : facts.likeMedianPct;
  return Math.max(facts.size ?? measured ?? score.defaultSizePct, score.minSizePct);
}

/** The band of a task; an expedite needs its arm on in `focus.expedite`. */
export function bandOf(facts: Pick<ScoreFacts, 'workClass' | 'critical' | 'priority' | 'ownerSourced'>, focus: Pick<ScoreFocus, 'roadmapClass' | 'maintenanceClass' | 'expedite'>): Band {
  const maintenance = facts.workClass === focus.maintenanceClass;
  if ((focus.expedite.critical && maintenance && facts.critical) || (focus.expedite.ownerP1 && facts.ownerSourced && facts.priority === 1)) {
    return 0;
  }
  return maintenance || facts.workClass === focus.roadmapClass ? 1 : 2;
}

/** A task's band and score at `now`. */
export function scoreOf(facts: ScoreFacts, focus: ScoreFocus, now: number): TaskScore {
  const { score } = focus;
  const costOfDelay = valueOf(facts, focus) + urgencyOf(facts.dueAt, now, score) + unblocksOf(facts.neededValue, score) + ownerOrderOf(facts, score);
  const sizePct = sizePctOf(facts.sizing, score);
  return { band: bandOf(facts, focus), score: Number((costOfDelay / sizePct).toFixed(2)), costOfDelay, sizePct };
}
