import type { BudgetConfig } from '../config/types.ts';
import { formatUtcDay, formatUtcHour, MS_PER_DAY } from '../core/time.ts';
import { DailyProfile } from './active-time.ts';
import { dailyAllowancePct, dayPacePct, readPace, resolveReset, weekWindow, type PaceReading, type TeamDay, type WeekWindow } from './pace.ts';
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
  /** The team's allowance for today, in percent of the week; undefined while the week's use or limit is unknown. */
  readonly allowancePct: number | undefined;
  /**
   * Where today's use is counted from: 00:00 UTC, or on the week's first day the instant it began, so the last
   * week's use that day is not today's (`wSince` counts from its hour).
   */
  readonly todayFrom: number;
  /** Everyone's W since `todayFrom`, the team's sessions and the use outside it. */
  readonly todayW: number;
  /** Everyone's use today against the team's in-day pace (`hasRoom`); undefined with the allowance. */
  readonly teamDay: TeamDay | undefined;
}

export interface WeekInput {
  readonly budget: BudgetConfig;
  readonly now: number;
  /** The newest status line reading of the week, if any. */
  readonly statusUse: WeekUse | undefined;
  /** Every usage store: each team session's and the outside one. */
  readonly states: readonly UsageState[];
}

/**
 * Everyone's W from the hour of `from` to `now`: the whole days after `from`'s UTC day and, on that day,
 * its W less its hours before `from`'s hour, which counts whole. A store whose hours were lost (an older
 * teamrig rewrote it) keeps them in, so its W errs high, never low.
 */
export function wSince(states: readonly UsageState[], from: number, now: number): number {
  const fromDay = formatUtcDay(new Date(from));
  const fromHour = formatUtcHour(new Date(from));
  const today = formatUtcDay(new Date(now));
  let total = 0;
  for (const state of states) {
    let before = 0;
    for (const [hour, w] of Object.entries(state.byHour)) {
      before += hour.startsWith(fromDay) && hour < fromHour ? w : 0;
    }
    for (const [day, usage] of Object.entries(state.byDay)) {
      total += day === fromDay ? Math.max(0, usage.w - before) : day > fromDay && day <= today ? usage.w : 0;
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
  const dayStart = now - (now % MS_PER_DAY);
  const todayFrom = window === undefined ? dayStart : Math.max(dayStart, window.start);
  const todayW = wSince(states, todayFrom, now);
  const startDay = window === undefined ? undefined : formatUtcDay(new Date(window.start));
  const first = earliestDay(states);
  const covered = startDay !== undefined && first !== undefined && first <= startDay;
  const weekW = window === undefined ? 0 : wSince(states, window.start, now);
  const estimate = statusUse !== undefined && covered && weekW > 0 && statusUse.usedPct > 0 ? weekW / statusUse.usedPct : undefined;
  const wPerPct = budget.weeklyLimitW === undefined ? estimate : budget.weeklyLimitW / 100;
  const usedPct = statusUse?.usedPct ?? (covered && wPerPct !== undefined ? weekW / wPerPct : undefined);
  const profile = DailyProfile.ofQuietHours(budget.quietHours);
  const pace = window === undefined || usedPct === undefined ? undefined : readPace(window, budget, now, usedPct, profile);
  const allowancePct =
    window === undefined || usedPct === undefined || wPerPct === undefined
      ? undefined
      : dailyAllowancePct({ window, budget, now, usedPct, todayPct: todayW / wPerPct, profile });
  const teamDay =
    window === undefined || wPerPct === undefined || allowancePct === undefined
      ? undefined
      : { usedPct: todayW / wPerPct, pacePct: dayPacePct({ window, now, allowancePct, profile }) };
  return {
    reset,
    window,
    usedPct,
    statusAt: statusUse?.at,
    wPerPct,
    limitEstimated: budget.weeklyLimitW === undefined && wPerPct !== undefined,
    covered,
    pace,
    allowancePct,
    todayFrom,
    todayW,
    teamDay,
  };
}
