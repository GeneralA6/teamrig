import { MS_PER_DAY } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { TeamDay } from './pace.ts';

/** How `teamrig budget` writes its numbers: short, and the same everywhere. */

/**
 * Why a session past its part is held, the same in the hook line and in `teamrig budget`:
 * "the team has used 3.1% of the week today, at or past its in-day pace of 3.0%".
 */
export function noRoomText(day: TeamDay): string {
  return `the team has used ${formatPct(day.usedPct)} of the week today, at or past its in-day pace of ${formatPct(day.pacePct)}`;
}

/** A share of the week: two decimals below 1%, else one, such as `0.25%` or `10.0%`. */
export function formatPct(value: number): string {
  return `${value.toFixed(Math.abs(value) < 1 && value !== 0 ? 2 : 1)}%`;
}

/** Weighted tokens: `850k`, `7.50M`, `1.20B`. */
export function formatW(value: number): string {
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`;
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(2)}M`;
  }
  return value >= 1e3 ? `${Math.round(value / 1e3)}k` : `${Math.round(value)}`;
}

/** A count with thousands separators, such as `2,634`. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/**
 * When something ends, on the team's clock: `18:00 IDT`, and at a UTC midnight `03:00 IDT (the end of the budget
 * day)`: budget days are UTC days, so the day a lift lasts ends there.
 */
export function formatEndTime(at: number, zone: TimeZone): string {
  const clock = zone.clock(new Date(at));
  return isBudgetDayEnd(at) ? `${clock} (the end of the budget day)` : clock;
}

/** Whether `at` is a UTC midnight, where a budget day ends. */
export function isBudgetDayEnd(at: number): boolean {
  return at % MS_PER_DAY === 0;
}
