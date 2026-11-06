import type { FocusConfig } from '../config/types.ts';
import type { StatsScope } from '../register/stats.ts';
import type { TeamDayRollup } from './rollup-file.ts';

/** Some task work: its W, raw as the rollup holds it, and its active seconds. */
export interface UseTotal {
  readonly w: number;
  readonly seconds: number;
}

/** Where a task's work of a day counts: the task's class, and whether the plan held the task that day. */
export interface TaskPlace {
  readonly workClass: string;
  readonly planned: boolean;
}

/** One work class's task W, split by the plan, against `focus.allocation`. */
export interface ClassUse {
  readonly workClass: string;
  readonly planned: UseTotal;
  readonly unplanned: UseTotal;
  /** The class's percent of the W with a task; null when there is none. */
  readonly sharePct: number | null;
  /** The class's percent in `focus.allocation`; null for a class it does not name. */
  readonly targetPct: number | null;
}

/** Task work over a span: how much the plan held, by class, with the work that named no task apart. */
export interface PlanUse {
  readonly planned: UseTotal;
  readonly unplanned: UseTotal;
  readonly noTask: UseTotal;
  /** Planned W as a percent of the W with a task; null when there is none. */
  readonly coveragePct: number | null;
  readonly targetPct: number;
  /** `focus.classes` in their order, each even at no W, then any other class a task holds, by name. */
  readonly classes: readonly ClassUse[];
}

export interface PlanUseInput {
  readonly days: readonly TeamDayRollup[];
  /** Where team `team`'s work on `task` counts on `day`. */
  readonly placeOf: (team: string, day: string, task: string) => TaskPlace;
  readonly focus: Pick<FocusConfig, 'classes' | 'allocation' | 'plannedTargetPct'>;
  /** Only this session's rows, when given. */
  readonly session?: StatsScope;
}

interface Tally {
  w: number;
  seconds: number;
}

interface ClassTally {
  readonly planned: Tally;
  readonly unplanned: Tally;
}

function newClassTally(): ClassTally {
  return { planned: { w: 0, seconds: 0 }, unplanned: { w: 0, seconds: 0 } };
}

function add(tally: Tally, use: UseTotal): void {
  tally.w += use.w;
  tally.seconds += use.seconds;
}

function sum(uses: readonly UseTotal[]): UseTotal {
  const total: Tally = { w: 0, seconds: 0 };
  uses.forEach((use) => add(total, use));
  return total;
}

function percentOf(part: number, whole: number): number | null {
  return whole === 0 ? null : (part / whole) * 100;
}

/**
 * The rollup's task rows split by plan and class (T2091, T2076's 3A). Only `tasks` rows are read: they hold task work
 * alone, so coordination stays the rollup's own class and out of every share here, and a share is of the W with a task.
 */
export function planUse({ days, placeOf, focus, session }: PlanUseInput): PlanUse {
  const byClass = new Map<string, ClassTally>(focus.classes.map((workClass) => [workClass, newClassTally()]));
  const noTask: Tally = { w: 0, seconds: 0 };
  for (const { day, team, tasks } of days) {
    for (const row of tasks) {
      if (session !== undefined && (team !== session.team || row.session !== session.session)) {
        continue;
      }
      if (row.task === null) {
        add(noTask, row);
        continue;
      }
      const { workClass, planned } = placeOf(team, day, row.task);
      const tally = byClass.get(workClass) ?? newClassTally();
      byClass.set(workClass, tally);
      add(planned ? tally.planned : tally.unplanned, row);
    }
  }
  const tallies = [...byClass.values()];
  const planned = sum(tallies.map((tally) => tally.planned));
  const unplanned = sum(tallies.map((tally) => tally.unplanned));
  const taskW = planned.w + unplanned.w;
  const others = [...byClass.keys()].filter((workClass) => !focus.classes.includes(workClass)).sort();
  const classes = [...focus.classes, ...others].flatMap((workClass) => {
    const tally = byClass.get(workClass);
    return tally === undefined ? [] : [{ workClass, ...tally, sharePct: percentOf(tally.planned.w + tally.unplanned.w, taskW), targetPct: focus.allocation[workClass] ?? null }];
  });
  return { planned, unplanned, noTask, coveragePct: percentOf(planned.w, taskW), targetPct: focus.plannedTargetPct, classes };
}
