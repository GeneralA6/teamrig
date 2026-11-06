import { WEEKDAYS, type FocusConfig, type Weekday } from '../config/types.ts';
import type { Task } from '../register/fold.ts';
import type { Band } from '../register/score.ts';
import type { TaskTree } from '../register/tree.ts';

/**
 * The order the agenda asks the owner's decisions in, and which wait for the weekly batch (T2076 2D). A decision is
 * worth what it frees, so each ranks by the tasks it unblocks, itself among them: an expedite first, then those that
 * free Roadmap work, then by best score. Pure: the caller reads which tasks ask the owner.
 */

/** The `focus` keys a decision's class reads; each register reads its own. */
export type DecisionFocus = Pick<FocusConfig, 'roadmapClass' | 'maintenanceClass'>;

/** One register's decisions. */
export interface DecisionRead {
  /** In its plan order, which a tie keeps. */
  readonly tasks: readonly Task[];
  readonly tree: TaskTree;
  /** Its name for a register under the meeting's; undefined for the meeting's own. */
  readonly team: string | undefined;
  readonly focus: DecisionFocus;
}

/** A decision, with the read of the register that holds it. */
export interface Decision {
  readonly task: Task;
  readonly tree: TaskTree;
  readonly team: string | undefined;
}

export interface DecisionOrder {
  readonly daily: readonly Decision[];
  /** What waits for the weekly batch, in the same order. */
  readonly improvements: readonly Decision[];
}

interface DecisionRank {
  readonly band: Band;
  readonly roadmap: boolean;
  readonly score: number;
}

/** The band a task with no ranked place reads as: after every other. */
const LAST_BAND: Band = 2;

/** The task and every active task of its register that needs it, directly or not, each once. */
export function unblockedBy(task: Task, tree: TaskTree): Task[] {
  const found = new Map([[task.id, task]]);
  const queue = [...tree.neededBy(task.id)];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (!found.has(next.id)) {
      found.set(next.id, next);
      queue.push(...tree.neededBy(next.id));
    }
  }
  return [...found.values()];
}

function rankOver(tasks: readonly Task[], tree: TaskTree, focus: DecisionFocus): DecisionRank {
  const places = tasks.flatMap((task) => tree.rankedOf(task) ?? []);
  return {
    band: places.reduce<Band>((best, place) => (place.band < best ? place.band : best), LAST_BAND),
    roadmap: places.some((place) => place.workClass === focus.roadmapClass),
    score: Math.max(0, ...places.map((place) => place.score)),
  };
}

function byRank(a: DecisionRank, b: DecisionRank): number {
  return a.band - b.band || Number(b.roadmap) - Number(a.roadmap) || b.score - a.score;
}

/**
 * True for a decision that may wait for the weekly batch: every task it unblocks has a stored class that is neither
 * Roadmap nor Maintenance, and none expedites. A task with no class stays on the daily: read as the default class, every
 * unclassed decision would leave the owner's sight until the batch, the same reason a null class never parks a task.
 */
function waitsForBatch(tasks: readonly Task[], tree: TaskTree, focus: DecisionFocus): boolean {
  return tasks.every((task) => task.workClass !== null && task.workClass !== focus.roadmapClass && task.workClass !== focus.maintenanceClass && tree.rankedOf(task)?.band !== 0);
}

/** The decisions of every register in one ranked list, a tie in the order handed in, split by {@link waitsForBatch}. */
export function decisionOrder(reads: readonly DecisionRead[]): DecisionOrder {
  const ranked = reads
    .flatMap(({ tasks, tree, team, focus }) =>
      tasks.map((task) => {
        const unblocked = unblockedBy(task, tree);
        return { decision: { task, tree, team }, rank: rankOver(unblocked, tree, focus), batched: waitsForBatch(unblocked, tree, focus) };
      }),
    )
    .sort((a, b) => byRank(a.rank, b.rank));
  return {
    daily: ranked.filter((row) => !row.batched).map((row) => row.decision),
    improvements: ranked.filter((row) => row.batched).map((row) => row.decision),
  };
}

/** True on the UTC weekday the Improvements batch is asked. */
export function isImprovementsDay(now: number, day: Weekday): boolean {
  return WEEKDAYS[new Date(now).getUTCDay()] === day;
}
