import type { BudgetConfig } from '../config/types.ts';
import { formatUtcDay, formatUtcHour, MS_PER_DAY, MS_PER_HOUR } from '../core/time.ts';
import { DailyProfile, type ActivityProfile } from './active-time.ts';
import type { Calibration } from './calibration.ts';
import { FULL_PCT, poolOf, type ExtraEntry, type ExtraPool } from './extra.ts';
import {
  dailyAllowancePct,
  dayPacePct,
  readPace,
  spanAllowancePct,
  weekWindow,
  type AllowanceInput,
  type PaceReading,
  type TeamDay,
  type WeekWindow,
} from './pace.ts';
import type { Metered, Period, PeriodKind } from './period.ts';
import type { WeekUse } from './snapshot.ts';
import type { UsageState } from './store.ts';

/**
 * Where the week's W per percent comes from: `learned` from the meter log's fit (budget/calibration.ts), the
 * configured `limit` (`budget.weeklyLimitW`) until there is one, else an `estimate` from the period's status line
 * reading and W alone.
 */
export type RateSource = 'learned' | 'limit' | 'estimate';

/**
 * Where the week stands: its use in percent, from the status line (the plan's own count) or, with a
 * known limit, from the metered W; the limit in W per percent, learned from the meter log, else from
 * `weeklyLimitW`, else estimated from the status line once the meter has counted the whole week; the pace
 * and today's team allowance.
 */
export interface WeekReading {
  readonly reset: number | undefined;
  readonly window: WeekWindow | undefined;
  /** How the window's start is known (budget/period.ts); undefined with the window. */
  readonly periodKind: PeriodKind | undefined;
  readonly usedPct: number | undefined;
  /** When the status line reading was taken; undefined when the use is metered or unknown. */
  readonly statusAt: number | undefined;
  /** W per percent of the week. */
  readonly wPerPct: number | undefined;
  /** Where `wPerPct` comes from; undefined with it. */
  readonly rateFrom: RateSource | undefined;
  /** The meter log's fit and its forecasts' error in each period. */
  readonly calibration: Calibration;
  /** The meter's counts reach back to the week's start, so the week's W is whole. */
  readonly covered: boolean;
  readonly pace: PaceReading | undefined;
  /** The team's allowance for today, in percent of the week; undefined while the week's use or limit is unknown. */
  readonly allowancePct: number | undefined;
  /**
   * Where today's use is counted from: 00:00 UTC, or on the day the period began (the weekly reset, or one inside
   * the week) that instant, so the use before it that day is not today's (`wSince` counts from its hour).
   */
  readonly todayFrom: number;
  /** Everyone's W since `todayFrom`, the team's sessions and the use outside it. */
  readonly todayW: number;
  /** Everyone's use today against the team's in-day pace (`hasRoom`); undefined with the allowance. */
  readonly teamDay: TeamDay | undefined;
  /** The extra-usage pool (budget/extra.ts); undefined while nothing was added or the week's use is unknown. */
  readonly pool: ExtraPool | undefined;
}

/** The extra-usage log's entries and where the period reached 100% of the week, for the pool past the weekly limit. */
export interface ExtraInput {
  readonly entries: readonly ExtraEntry[];
  /** The W the meter log's line at 100% of this period carries (`wAtFullOf`); undefined before the week reached it. */
  readonly wAtFull: number | undefined;
}

export interface WeekInput {
  readonly budget: BudgetConfig;
  readonly now: number;
  /** The newest status line reading of the week, if any. */
  readonly statusUse: WeekUse | undefined;
  /** The span the use counts in (budget/period.ts); undefined while no reset is known. */
  readonly period: Pick<Period, 'start' | 'end' | 'kind'> | undefined;
  /** Every usage store: each team session's and the outside one. */
  readonly states: readonly UsageState[];
  /** The meter log's fit and forecasts (budget/calibration.ts); the fit, once there is one, sets the rate. */
  readonly calibration: Calibration;
  /** The extra-usage log; unset, the week ends at its weekly limit with no pool past it. */
  readonly extra?: ExtraInput;
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

/**
 * Everyone's W from the hour of `from` to `now` that fell in inactive time: each hour's W times the part of that hour
 * the profile does not count as active, so a quiet hour's whole W at the default `paceWeight` of 0. It counts `from`'s
 * hour whole, as `wSince` does. A store whose hours were lost adds nothing, so the in-day pace errs low.
 */
export function idleWSince(states: readonly UsageState[], from: number, now: number, profile: ActivityProfile): number {
  let total = 0;
  for (let hour = from - (from % MS_PER_HOUR); hour <= now; hour += MS_PER_HOUR) {
    const idleShare = 1 - profile.activeMs(hour, hour + MS_PER_HOUR) / MS_PER_HOUR;
    if (idleShare <= 0) {
      continue;
    }
    const key = formatUtcHour(new Date(hour));
    for (const state of states) {
      total += (state.byHour[key] ?? 0) * idleShare;
    }
  }
  return total;
}

/** W per percent of the week from `budget.weeklyLimitW`; undefined without it. */
export function limitWPerPct(budget: Pick<BudgetConfig, 'weeklyLimitW'>): number | undefined {
  return budget.weeklyLimitW === undefined ? undefined : budget.weeklyLimitW / 100;
}

/** The usage stores' W for the period's inference (budget/period.ts) at `wPerPct`; undefined without it. */
export function meteredOf(wPerPct: number | undefined, states: readonly UsageState[], now: number): Metered | undefined {
  return wPerPct === undefined ? undefined : { wPerPct, wFrom: (from) => wSince(states, from, now) };
}

/** The week's W per percent and where it comes from (`RateSource`), first that is known; undefined while none is. */
export function rateOf(
  calibration: Calibration,
  budget: Pick<BudgetConfig, 'weeklyLimitW'>,
  estimate: number | undefined,
): { readonly wPerPct: number; readonly from: RateSource } | undefined {
  if (calibration.fit !== undefined) {
    return { wPerPct: calibration.fit.wPerPct, from: 'learned' };
  }
  const limit = limitWPerPct(budget);
  if (limit !== undefined) {
    return { wPerPct: limit, from: 'limit' };
  }
  return estimate === undefined ? undefined : { wPerPct: estimate, from: 'estimate' };
}

function earliestDay(states: readonly UsageState[]): string | undefined {
  const days = states.flatMap((state) => Object.keys(state.byDay)).sort();
  return days[0];
}

/**
 * The team's allowance today: the week's, to its target (`dailyAllowancePct`); at or past 100% of the week, the W the
 * extra-usage pool still holds, spread over the active time to the pace end like the week's, so the pool lasts to the
 * reset instead of going in a day. Recomputed at every reading as the pool is spent; none with the pool empty.
 */
function teamAllowancePct(input: AllowanceInput, pool: ExtraPool | undefined, wPerPct: number): number {
  const leftW = pool?.leftW;
  if (input.usedPct < FULL_PCT || leftW === undefined || leftW <= 0) {
    return dailyAllowancePct(input);
  }
  const { window, now, usedPct, todayPct, profile } = input;
  return spanAllowancePct({ start: window.start, end: window.paceEnd, stopPct: usedPct + leftW / wPerPct, now, usedPct, todayPct, profile });
}

export function readWeek(input: WeekInput): WeekReading {
  const { budget, now, statusUse, states, period, calibration, extra } = input;
  const reset = period?.end;
  const window = period === undefined ? undefined : weekWindow(period.end, budget.paceEndHoursBeforeReset, period.start);
  const dayStart = now - (now % MS_PER_DAY);
  const todayFrom = window === undefined ? dayStart : Math.max(dayStart, window.start);
  const todayW = wSince(states, todayFrom, now);
  const startDay = window === undefined ? undefined : formatUtcDay(new Date(window.start));
  const first = earliestDay(states);
  const covered = startDay !== undefined && first !== undefined && first <= startDay;
  const weekW = window === undefined ? 0 : wSince(states, window.start, now);
  const estimate = statusUse !== undefined && covered && weekW > 0 && statusUse.usedPct > 0 ? weekW / statusUse.usedPct : undefined;
  const rate = rateOf(calibration, budget, estimate);
  const wPerPct = rate?.wPerPct;
  const usedPct = statusUse?.usedPct ?? (covered && wPerPct !== undefined ? weekW / wPerPct : undefined);
  const profile = DailyProfile.ofQuietHours(budget.quietHours);
  const pace = window === undefined || usedPct === undefined ? undefined : readPace(window, budget, now, usedPct, profile);
  const pool =
    extra === undefined || window === undefined || usedPct === undefined
      ? undefined
      : poolOf(extra.entries, { start: window.start, w: weekW, usedPct, wAtFull: extra.wAtFull, configuredWPerUsd: budget.extraWPerUsd });
  const allowancePct =
    window === undefined || usedPct === undefined || wPerPct === undefined
      ? undefined
      : teamAllowancePct({ window, budget, now, usedPct, todayPct: todayW / wPerPct, profile }, pool, wPerPct);
  const teamDay =
    window === undefined || wPerPct === undefined || allowancePct === undefined
      ? undefined
      : { usedPct: todayW / wPerPct, pacePct: dayPacePct({ window, now, allowancePct, idlePct: idleWSince(states, todayFrom, now, profile) / wPerPct, profile }) };
  return {
    reset,
    window,
    periodKind: period?.kind,
    usedPct,
    statusAt: statusUse?.at,
    wPerPct,
    rateFrom: rate?.from,
    calibration,
    covered,
    pace,
    allowancePct,
    todayFrom,
    todayW,
    teamDay,
    pool,
  };
}
