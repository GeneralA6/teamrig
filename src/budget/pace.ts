import { WEEKDAYS, type BudgetConfig, type BudgetReset } from '../config/types.ts';
import { MS_PER_DAY, MS_PER_HOUR } from '../core/time.ts';
import type { ActivityProfile } from './active-time.ts';

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

/**
 * Where the pace line stands at `at`: 0 at the week's start, rising with the active time (`profile`) to the target at
 * the pace end, then flat; so it stays flat through the hours the team sleeps. A pace span with no active time rises
 * evenly with clock time instead.
 */
export function paceLinePct(window: WeekWindow, targetPct: number, at: number, profile: ActivityProfile): number {
  const span = window.paceEnd - window.start;
  if (span <= 0 || at >= window.paceEnd) {
    return targetPct;
  }
  if (at <= window.start) {
    return 0;
  }
  const active = profile.activeMs(window.start, window.paceEnd);
  return active > 0 ? (targetPct * profile.activeMs(window.start, at)) / active : (targetPct * (at - window.start)) / span;
}

export type PaceBudget = Pick<BudgetConfig, 'targetPct' | 'paceEndHoursBeforeReset' | 'paceTolerancePct'>;

export interface AllowanceInput {
  readonly window: WeekWindow;
  readonly budget: PaceBudget;
  readonly now: number;
  /** The week's use now, in percent. */
  readonly usedPct: number;
  /** The team's use since 00:00 UTC today, in percent of the week. */
  readonly todayPct: number;
  /** The active time the pace counts. */
  readonly profile: ActivityProfile;
}

/**
 * The team's allowance for today, in percent of the week, never a fixed number: recomputed at every reading from
 * what is left to the target, spread evenly over the active time from now to the pace end, times today's active
 * time (the UTC day inside the week and before the pace end). On pace it holds all day; using less raises it and
 * using more lowers it, so the team never waits while the week has room, and an idle evening does not shrink it.
 * Never above today's use plus what is left, which is all it is past the pace end or with no active time left
 * before it.
 */
export function dailyAllowancePct(input: AllowanceInput): number {
  const { window, budget, now, profile } = input;
  const leftPct = Math.max(0, budget.targetPct - input.usedPct);
  const ceiling = input.todayPct + leftPct;
  const remaining = profile.activeMs(now, window.paceEnd);
  if (remaining <= 0) {
    return ceiling;
  }
  const dayStart = now - (now % MS_PER_DAY);
  const today = profile.activeMs(Math.max(dayStart, window.start), Math.min(dayStart + MS_PER_DAY, window.paceEnd));
  return Math.min((leftPct * today) / remaining, ceiling);
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
export function readPace(window: WeekWindow, budget: PaceBudget, now: number, usedPct: number, profile: ActivityProfile): PaceReading {
  const linePct = paceLinePct(window, budget.targetPct, now, profile);
  const gapPts = usedPct - linePct;
  const state: PaceState = Math.abs(gapPts) <= budget.paceTolerancePct ? 'on pace' : gapPts > 0 ? 'ahead' : 'behind';
  return { window, linePct, gapPts, state };
}
