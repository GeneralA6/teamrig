/** UTC date helpers. The kit stores instants as ISO strings and shows minutes as `YYYY-MM-DD HH:MM`. */

const DAY_OR_MINUTE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/;

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

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

/** A stored day or minute without its year, for compact lines: `2030-01-09 12:00` → `01-09 12:00`. */
export function shortUtc(text: string): string {
  return text.slice(5).replace('T', ' ');
}

/** `YYYY-MM-DD HH:MM` in UTC. */
export function formatUtcMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

/** `YYYY-MM-DD` in UTC. */
export function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
