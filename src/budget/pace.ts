import { DEFAULT_SESSION_SHARE } from '../config/defaults.ts';
import { WEEKDAYS, type BudgetConfig, type BudgetReset, type SessionBudget } from '../config/types.ts';
import { MS_PER_DAY, MS_PER_HOUR } from '../core/time.ts';

/**
 * The pace math of the weekly budget, pure so every edge of the week is tested with plain numbers.
 * All instants are epoch milliseconds; all shares are percent of the week's limit.
 */

const MS_PER_WEEK = 7 * MS_PER_DAY;
const MS_PER_MINUTE = 60_000;

/** One week of the plan's limit: from the last reset to the next, and the end of the pace line before it. */
export interface WeekWindow {
  readonly start: number;
  readonly reset: number;
  /** Where the pace line reaches the target; the hours after it are the reserve's. */
  readonly paceEnd: number;
}

/** The first reset strictly after `now` on the config's weekday and UTC time. */
export function nextConfiguredReset(now: number, reset: BudgetReset): number {
  const [hours = 0, minutes = 0] = reset.timeUtc.split(':').map(Number);
  const dayStart = now - (now % MS_PER_DAY);
  const today = new Date(dayStart).getUTCDay();
  const daysAhead = (WEEKDAYS.indexOf(reset.weekday) - today + 7) % 7;
  const candidate = dayStart + daysAhead * MS_PER_DAY + hours * MS_PER_HOUR + minutes * MS_PER_MINUTE;
  return candidate > now ? candidate : candidate + MS_PER_WEEK;
}

/**
 * The next reset: the status line's when it reports one still ahead (the plan's own clock), else the
 * config's weekday and time; undefined with neither.
 */
export function resolveReset(now: number, fromStatus: number | undefined, configured: BudgetReset | undefined): number | undefined {
  if (fromStatus !== undefined && fromStatus > now) {
    return fromStatus;
  }
  return configured === undefined ? undefined : nextConfiguredReset(now, configured);
}

/** The week ending at `reset`, its pace line ending `paceEndHoursBeforeReset` hours before. */
export function weekWindow(reset: number, paceEndHoursBeforeReset: number): WeekWindow {
  const start = reset - MS_PER_WEEK;
  return { start, reset, paceEnd: Math.max(start, reset - paceEndHoursBeforeReset * MS_PER_HOUR) };
}

/** Where the pace line stands at `at`: 0 at the week's start, rising evenly to the target at the pace end, then flat. */
export function paceLinePct(window: WeekWindow, targetPct: number, at: number): number {
  const span = window.paceEnd - window.start;
  if (span <= 0 || at >= window.paceEnd) {
    return targetPct;
  }
  return at <= window.start ? 0 : (targetPct * (at - window.start)) / span;
}

export type PaceBudget = Pick<BudgetConfig, 'targetPct' | 'paceEndHoursBeforeReset' | 'dailyPct' | 'maxDailyPct' | 'paceTolerancePct'>;

export interface AllowanceInput {
  readonly window: WeekWindow;
  readonly budget: PaceBudget;
  readonly now: number;
  /** The week's use now, in percent. */
  readonly usedPct: number;
  /** The team's use since 00:00 UTC today, in percent of the week. */
  readonly todayPct: number;
}

/**
 * The team's allowance for today, in percent of the week: the config's fixed `dailyPct`, else what is
 * left to the target at 00:00 UTC spread evenly over the days from 00:00 to the pace end (at least
 * one, so past the pace end it is all that is left). Fixed at 00:00, so it does not grow as the day is
 * used. When the week began after 00:00 (the reset day) it is counted from the reset, with nothing used.
 * Never above `maxDailyPct`.
 */
export function dailyAllowancePct(input: AllowanceInput): number {
  const { window, budget, now } = input;
  const cap = budget.maxDailyPct ?? Number.POSITIVE_INFINITY;
  if (budget.dailyPct !== undefined) {
    return Math.min(budget.dailyPct, cap);
  }
  const dayStart = now - (now % MS_PER_DAY);
  const from = Math.max(dayStart, window.start);
  const usedAtStart = from === window.start && dayStart < window.start ? 0 : Math.max(0, input.usedPct - input.todayPct);
  const days = Math.max(1, (window.paceEnd - from) / MS_PER_DAY);
  return Math.min(Math.max(0, budget.targetPct - usedAtStart) / days, cap);
}

/**
 * Each session's part of the team allowance: its fixed `dailyPct`, else a share of what the fixed ones
 * leave, split by `share` among the team's other sessions (`ids`, the whole roster).
 */
export function sessionBudgetPct(allowancePct: number, session: string, ids: readonly string[], sessions: Readonly<Record<string, SessionBudget>>): number {
  const own = sessions[session]?.dailyPct;
  if (own !== undefined) {
    return own;
  }
  const shareOf = (id: string): number => sessions[id]?.share ?? DEFAULT_SESSION_SHARE;
  let fixed = 0;
  let shares = 0;
  for (const id of ids) {
    const daily = sessions[id]?.dailyPct;
    if (daily === undefined) {
      shares += shareOf(id);
    } else {
      fixed += daily;
    }
  }
  return shares > 0 ? (Math.max(0, allowancePct - fixed) * shareOf(session)) / shares : 0;
}

export type PaceState = 'ahead' | 'behind' | 'on pace';

/** Where the week stands against the pace line now. */
export interface PaceReading {
  readonly window: WeekWindow;
  readonly linePct: number;
  /** Use minus the line, in points: positive is ahead of the line. */
  readonly gapPts: number;
  readonly state: PaceState;
}

/** The week's use against the pace line; within `paceTolerancePct` points it is on pace. */
export function readPace(window: WeekWindow, budget: PaceBudget, now: number, usedPct: number): PaceReading {
  const linePct = paceLinePct(window, budget.targetPct, now);
  const gapPts = usedPct - linePct;
  const state: PaceState = Math.abs(gapPts) <= budget.paceTolerancePct ? 'on pace' : gapPts > 0 ? 'ahead' : 'behind';
  return { window, linePct, gapPts, state };
}
