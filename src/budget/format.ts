import { MS_PER_DAY } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';

/** How `teamrig budget` writes its numbers: short, and the same everywhere. */

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
  return at % MS_PER_DAY === 0 ? `${clock} (the end of the budget day)` : clock;
}

/** A stretch of the day on the team's clock: `01:00-09:00 IDT`, or `01:00 IDT-08:00 IST` across a change of clocks. */
export function formatClockSpan(from: number, to: number, zone: TimeZone): string {
  const start = zone.clock(new Date(from));
  const end = zone.clock(new Date(to));
  const label = zone.label(new Date(from));
  return label === zone.label(new Date(to)) ? `${start.slice(0, -label.length - 1)}-${end}` : `${start}-${end}`;
}

const WEEKDAY_NAMES: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** An instant as `Wed 10-21 01:00 UTC`. */
export function formatWeekdayMinute(at: number): string {
  const date = new Date(at);
  return `${WEEKDAY_NAMES[date.getUTCDay()] ?? ''} ${date.toISOString().slice(5, 16).replace('T', ' ')} UTC`;
}
