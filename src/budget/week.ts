import type { BudgetConfig } from '../config/types.ts';
import { formatUtcDay } from '../core/time.ts';
import { dailyAllowancePct, readPace, resolveReset, weekWindow, type PaceReading, type WeekWindow } from './pace.ts';
import type { WeekUse } from './snapshot.ts';
import type { UsageState } from './store.ts';

/**
 * Where the week stands: its use in percent, from the status line (the plan's own count) or, with a
 * known limit, from the metered W; the limit in W per percent, from `weeklyLimitW` or estimated from
 * the status line once the meter has counted the whole week; the pace and today's team allowance.
 */
export interface WeekReading {
  readonly reset: number | undefined;
  readonly window: WeekWindow | undefined;
  readonly usedPct: number | undefined;
  /** When the status line reading was taken; undefined when the use is metered or unknown. */
  readonly statusAt: number | undefined;
  /** W per percent of the week. */
  readonly wPerPct: number | undefined;
  /** The limit is an estimate from the status line, not `budget.weeklyLimitW`. */
  readonly limitEstimated: boolean;
  /** The meter's counts reach back to the week's start, so the week's W is whole. */
  readonly covered: boolean;
  readonly pace: PaceReading | undefined;
  /** The team's allowance for today, in percent of the week. */
  readonly allowancePct: number | undefined;
  /** Everyone's W today: the team's sessions and the use outside it. */
  readonly todayW: number;
}

export interface WeekInput {
  readonly budget: BudgetConfig;
  readonly now: number;
  /** The newest status line reading of the week, if any. */
  readonly statusUse: WeekUse | undefined;
  /** Every usage store: each team session's and the outside one. */
  readonly states: readonly UsageState[];
}

function sumW(states: readonly UsageState[], counts: (day: string) => boolean): number {
  let total = 0;
  for (const state of states) {
    for (const [day, usage] of Object.entries(state.byDay)) {
      total += counts(day) ? usage.w : 0;
    }
  }
  return total;
}

function earliestDay(states: readonly UsageState[]): string | undefined {
  const days = states.flatMap((state) => Object.keys(state.byDay)).sort();
  return days[0];
}

export function readWeek(input: WeekInput): WeekReading {
  const { budget, now, statusUse, states } = input;
  const reset = resolveReset(now, statusUse?.resetsAt, budget.reset);
  const window = reset === undefined ? undefined : weekWindow(reset, budget.paceEndHoursBeforeReset);
  const today = formatUtcDay(new Date(now));
  const todayW = sumW(states, (day) => day === today);
  const startDay = window === undefined ? undefined : formatUtcDay(new Date(window.start));
  const first = earliestDay(states);
  const covered = startDay !== undefined && first !== undefined && first <= startDay;
  const weekW = startDay === undefined ? 0 : sumW(states, (day) => day >= startDay && day <= today);
  const estimate = statusUse !== undefined && covered && weekW > 0 && statusUse.usedPct > 0 ? weekW / statusUse.usedPct : undefined;
  const wPerPct = budget.weeklyLimitW === undefined ? estimate : budget.weeklyLimitW / 100;
  const usedPct = statusUse?.usedPct ?? (covered && wPerPct !== undefined ? weekW / wPerPct : undefined);
  const pace = window === undefined || usedPct === undefined ? undefined : readPace(window, budget, now, usedPct);
  const allowancePct =
    window === undefined || usedPct === undefined || wPerPct === undefined
      ? undefined
      : dailyAllowancePct({ window, budget, now, usedPct, todayPct: todayW / wPerPct });
  return {
    reset,
    window,
    usedPct,
    statusAt: statusUse?.at,
    wPerPct,
    limitEstimated: budget.weeklyLimitW === undefined && wPerPct !== undefined,
    covered,
    pace,
    allowancePct: allowancePct ?? (budget.dailyPct === undefined ? undefined : Math.min(budget.dailyPct, budget.maxDailyPct ?? budget.dailyPct)),
    todayW,
  };
}
