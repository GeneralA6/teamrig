/**
 * Date helpers. The kit stores instants as ISO strings in UTC, a minute as `YYYY-MM-DD HH:MM` in UTC and a day as
 * `YYYY-MM-DD`, a day of the team's zone; it shows people every time in that zone (zone.ts).
 */
import { TimeZone } from './zone.ts';

const DAY_OR_MINUTE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

const CLOCK = /^(\d{2}):(\d{2})$/;

/** An ISO time with its zone; one without would be read in the host's local time. */
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
export const MS_PER_WEEK = 7 * MS_PER_DAY;

/** Minutes since 00:00 UTC of an `HH:MM`; undefined when malformed. */
export function utcMinuteOf(text: string): number | undefined {
  const match = CLOCK.exec(text);
  if (match === null) {
    return undefined;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}

/** True when a minute of the day is in the span from `start` (in) to `end` (out), which may cross midnight. */
export function isMinuteInSpan(minute: number, start: number, end: number): boolean {
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * Parses `YYYY-MM-DD` or `YYYY-MM-DD HH:MM` as UTC. A bare day means the end of that day,
 * so "due 2030-01-31" is still on time at 23:59 UTC. Undefined for malformed or impossible dates.
 */
export function parseUtcDeadline(text: string): Date | undefined {
  const match = DAY_OR_MINUTE.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const hasTime = match[4] !== undefined;
  const [hour, minute] = hasTime ? [Number(match[4]), Number(match[5])] : [23, 59];
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, hasTime ? 0 : 59, hasTime ? 0 : 999));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : undefined;
}

/** Parses a bare `YYYY-MM-DD` as the START of that UTC day (a week tag, not a deadline). */
export function parseUtcDay(text: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
    return undefined;
  }
  const end = parseUtcDeadline(text);
  return end === undefined ? undefined : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
}

/** The bare day `days` calendar days after (or before, when negative) the bare day `text`; undefined when it is no day. */
export function addUtcDays(text: string, days: number): string | undefined {
  const day = parseUtcDay(text);
  return day === undefined
    ? undefined
    : formatUtcDay(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + days)));
}

/** `YYYY-MM-DD HH:MM` in UTC. */
export function formatUtcMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

/** `YYYY-MM-DD` in UTC. */
export function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DDTHH` in UTC: the hour, which sorts as text in time order. */
export function formatUtcHour(date: Date): string {
  return date.toISOString().slice(0, 13);
}

/** A minute a person types, with or without its day, and maybe marked with its zone: `2030-01-31 09:05 IST`. */
const TYPED_MINUTE = /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}:\d{2})(?: (\S+))?$/;

/** A stored day `YYYY-MM-DD` (a week tag): the start of that day in the team's zone. */
export function parseDayStart(text: string, zone: TimeZone): Date | undefined {
  const day = parseUtcDay(text);
  return day === undefined ? undefined : zone.instant(TimeZone.UTC.wall(day));
}

/**
 * A stored deadline: `YYYY-MM-DD HH:MM` is that minute in UTC, and a bare `YYYY-MM-DD` the end of that day in the
 * team's zone, so "due 2030-01-31" is on time until 23:59 there. Undefined for malformed or impossible dates.
 */
export function parseDeadline(text: string, zone: TimeZone): Date | undefined {
  const day = parseUtcDay(text);
  if (day === undefined) {
    return parseUtcDeadline(text);
  }
  const nextDay = zone.instant(TimeZone.UTC.wall(new Date(day.getTime() + MS_PER_DAY)));
  return new Date(nextDay.getTime() - 1);
}

/** A stored day or minute as people read it in full: `2030-01-31`, or `2030-01-31 11:05 IST` for `2030-01-31 09:05`. */
export function storedText(text: string, zone: TimeZone): string {
  const trimmed = text.trim();
  const at = parseUtcDay(trimmed) === undefined ? parseUtcDeadline(trimmed) : undefined;
  return at === undefined ? trimmed : zone.minute(at);
}

/** A stored day or minute as people read it, without the year: `01-31`, or `01-31 11:05 IST` for `2030-01-31 09:05`. */
export function showStored(text: string, zone: TimeZone): string {
  const trimmed = text.trim();
  if (parseUtcDay(trimmed) !== undefined) {
    return trimmed.slice(5);
  }
  const at = parseUtcDeadline(trimmed);
  return at === undefined ? trimmed : zone.shortMinute(at);
}

/**
 * A time a person types, read on the team zone's clock unless marked UTC: `HH:MM` today there or
 * `YYYY-MM-DD HH:MM`, each unmarked, marked `UTC` or marked with the zone's name at that time (`09:05 IST`);
 * `YYYY-MM-DD`, the start of that day there; or an ISO time with its zone. Undefined for anything else, a mark of
 * another zone and an impossible date included.
 */
export function parseTypedInstant(text: string, nowMs: number, zone: TimeZone): Date | undefined {
  const trimmed = text.trim();
  if (ZONED_ISO.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? new Date(ms) : undefined;
  }
  const match = TYPED_MINUTE.exec(trimmed);
  if (match === null) {
    return parseDayStart(trimmed, zone);
  }
  const [, day = zone.day(new Date(nowMs)), clock = '', mark] = match;
  const wallAsUtc = parseUtcDeadline(`${day} ${clock}`);
  if (wallAsUtc === undefined || mark?.toUpperCase() === 'UTC') {
    return wallAsUtc;
  }
  const at = zone.instant(TimeZone.UTC.wall(wallAsUtc));
  return mark === undefined || mark.toUpperCase() === zone.label(at).toUpperCase() ? at : undefined;
}

/**
 * The stored form of a deadline a person types: a bare day stays that day of the team's zone, and a time, read as
 * `parseTypedInstant` reads it, becomes its minute in UTC. Undefined when it reads as neither.
 */
export function storedDeadline(text: string, nowMs: number, zone: TimeZone): string | undefined {
  const trimmed = text.trim();
  if (parseUtcDay(trimmed) !== undefined) {
    return trimmed;
  }
  const at = parseTypedInstant(trimmed, nowMs, zone);
  return at === undefined ? undefined : formatUtcMinute(at);
}

/** A deadline a person types, as the instant its stored form (`storedDeadline`) reads as; undefined when it reads as neither. */
export function typedDeadline(text: string, nowMs: number, zone: TimeZone): Date | undefined {
  const stored = storedDeadline(text, nowMs, zone);
  return stored === undefined ? undefined : parseDeadline(stored, zone);
}

/**
 * How to type a time, for refusals: `HH:MM or YYYY-MM-DD HH:MM in Asia/Jerusalem (IST), or marked UTC`, or for a team
 * whose clock is UTC, `HH:MM or YYYY-MM-DD HH:MM in UTC`.
 */
export function typedTimeHint(zone: TimeZone, nowMs: number): string {
  const label = zone.label(new Date(nowMs));
  return label === TimeZone.UTC.name ? 'HH:MM or YYYY-MM-DD HH:MM in UTC' : `HH:MM or YYYY-MM-DD HH:MM in ${zone.name} (${label}), or marked UTC`;
}
