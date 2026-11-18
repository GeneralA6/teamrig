import { formatUtcMinute } from './time.ts';
import type { TimeZone } from './zone.ts';

/**
 * The hour on the team's clock that `tomorrow` and `monday` put a card off to: the start of a working morning, the
 * pane's Later list (teamrig-pane issue #130: in 1 h, tomorrow 09:00, next Monday 09:00).
 */
export const LATER_HOUR = 9;

/** The most hours `in-<n>h` puts a card off by: a week, past which a day names it better. */
export const MAX_LATER_HOURS = 168;

/** The named forms, for the usage line that lists them. */
export const LATER_FORMS = 'in-<n>h, tomorrow, monday';

const IN_HOURS = /^in-(\d{1,3})h$/;
const MS_PER_HOUR = 3_600_000;
/** Sunday is 0, as `Date.getUTCDay` counts. */
const MONDAY = 1;
const DAYS_PER_WEEK = 7;

/** `hour`:00 on the team's clock `days` days after the day `nowMs` falls on there. */
function hourDaysAhead(nowMs: number, zone: TimeZone, days: number, hour: number): Date {
  const today = zone.wall(new Date(nowMs));
  const day = new Date(Date.UTC(today.year, today.month - 1, today.day + days));
  return zone.instant({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute: 0 });
}

/** How many days from the day `nowMs` falls on in `zone` to the next Monday there: 7 on a Monday. */
function daysToMonday(nowMs: number, zone: TimeZone): number {
  const today = zone.wall(new Date(nowMs));
  const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  return (MONDAY - weekday + DAYS_PER_WEEK) % DAYS_PER_WEEK || DAYS_PER_WEEK;
}

/**
 * A named time a card is put off to, in the stored form of a deadline (a UTC minute): `in-<n>h` (n hours from now, 1
 * to MAX_LATER_HOURS), `tomorrow` (LATER_HOUR on the team's clock the next day) or `monday` (LATER_HOUR the next
 * Monday, a week on when today is one). Undefined for any other text, which the caller reads as a typed time.
 */
export function namedLaterTime(text: string, nowMs: number, zone: TimeZone): string | undefined {
  const named = text.trim().toLowerCase();
  const hours = IN_HOURS.exec(named)?.[1];
  if (hours !== undefined) {
    const count = Number(hours);
    return count >= 1 && count <= MAX_LATER_HOURS ? formatUtcMinute(new Date(nowMs + count * MS_PER_HOUR)) : undefined;
  }
  if (named === 'tomorrow') {
    return formatUtcMinute(hourDaysAhead(nowMs, zone, 1, LATER_HOUR));
  }
  if (named === 'monday') {
    return formatUtcMinute(hourDaysAhead(nowMs, zone, daysToMonday(nowMs, zone), LATER_HOUR));
  }
  return undefined;
}
