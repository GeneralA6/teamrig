import { MS_PER_DAY } from '../core/time.ts';

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

/** An instant as `HH:MM UTC`. */
export function formatTimeOfDay(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

/** When something ends: `HH:MM UTC`, or `the end of the day (UTC)` at midnight. */
export function formatEndTime(at: number): string {
  return at % MS_PER_DAY === 0 ? 'the end of the day (UTC)' : formatTimeOfDay(at);
}

const WEEKDAY_NAMES: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** An instant as `Wed 10-21 01:00 UTC`. */
export function formatWeekdayMinute(at: number): string {
  const date = new Date(at);
  return `${WEEKDAY_NAMES[date.getUTCDay()] ?? ''} ${date.toISOString().slice(5, 16).replace('T', ' ')} UTC`;
}
