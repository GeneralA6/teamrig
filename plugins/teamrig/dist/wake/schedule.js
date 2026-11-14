import { isRecord } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { MS_PER_DAY, MS_PER_MINUTE, utcMinuteOf } from "../core/time.js";
import { dayStartAt, nextDayStartAt } from "./day-start.js";
/**
 * The fleet's day schedule (T2000), pure: the root team's lead writes, day by day, when each team or session starts
 * (`HH:MM` UTC) or that it does not start (`none`), in place of one fixed `wake.dayStartUtc` for every day. A
 * session's start is its own entry, else its team's, on that UTC day; a day with neither repeats the newest earlier
 * day that had one (`repeat`), and a schedule that never named it leaves the team's `wake.dayStartUtc` in charge,
 * exactly as before the schedule.
 *
 * A scheduled start counts only from its own time on its own day: before it, no day start is due, so a session held
 * idle all yesterday is not woken by yesterday's start at the end of quiet hours with every other such session.
 */
export const DAY_SCHEDULE_FORMAT = 1;
/** Days kept behind the newest one written: enough to repeat a week of days the lead did not write. */
export const DAY_SCHEDULE_KEEP_DAYS = 14;
/** The value that says a team or session has no day start that day. */
export const NO_START = 'none';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Whether `text` is a UTC day, `YYYY-MM-DD`, that is a real date. */
export function isScheduleDay(text) {
    return DAY_PATTERN.test(text) && new Date(Date.parse(`${text}T00:00:00.000Z`)).toISOString().startsWith(text);
}
/** The UTC day of `at`, `YYYY-MM-DD`. */
export function scheduleDayOf(at) {
    return new Date(at).toISOString().slice(0, 10);
}
/** A start as the lead writes it: `HH:MM` (UTC) or `none`; undefined for anything else. */
export function parseScheduledStart(text) {
    if (text === NO_START) {
        return { kind: 'none' };
    }
    const minute = utcMinuteOf(text);
    return minute === undefined ? undefined : { kind: 'at', minute };
}
/** A start as the file and the lead read it. */
export function scheduledStartText(start) {
    if (start.kind === 'none') {
        return NO_START;
    }
    const hours = Math.floor(start.minute / 60);
    const minutes = start.minute % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
/** The schedule in `text`; undefined for another format or no JSON object. A day or entry it cannot read is left out. */
export function parseDaySchedule(text) {
    const record = parseObject(text.trim());
    const written = record?.['days'];
    if (record === undefined || record[VERSION_FIELD] !== DAY_SCHEDULE_FORMAT || !isRecord(written)) {
        return undefined;
    }
    const days = new Map();
    for (const [day, entries] of Object.entries(written)) {
        if (!isScheduleDay(day) || !isRecord(entries)) {
            continue;
        }
        const starts = new Map();
        for (const [key, value] of Object.entries(entries)) {
            const start = typeof value === 'string' && key.length > 0 ? parseScheduledStart(value) : undefined;
            if (start !== undefined) {
                starts.set(key, start);
            }
        }
        days.set(day, starts);
    }
    return { days };
}
/** The schedule as its file holds it, days in order. */
export function formatDaySchedule(schedule) {
    const days = Object.fromEntries([...schedule.days.keys()].sort().map((day) => [day, Object.fromEntries([...(schedule.days.get(day) ?? new Map())].map(([key, start]) => [key, scheduledStartText(start)]))]));
    return toJsonlLine({ [VERSION_FIELD]: DAY_SCHEDULE_FORMAT, days });
}
/**
 * The schedule with `starts` written on `day` over what that day held, and the days more than
 * `DAY_SCHEDULE_KEEP_DAYS` before the newest day dropped.
 */
export function withDayStarts(schedule, day, starts) {
    const days = new Map(schedule?.days ?? []);
    days.set(day, new Map([...(days.get(day) ?? []), ...starts]));
    const newest = [...days.keys()].sort().at(-1) ?? day;
    const oldestKept = scheduleDayOf(Date.parse(`${newest}T00:00:00.000Z`) - DAY_SCHEDULE_KEEP_DAYS * MS_PER_DAY);
    for (const kept of [...days.keys()]) {
        if (kept < oldestKept) {
            days.delete(kept);
        }
    }
    return { days };
}
/** The first of `keys` (most specific first) that `starts` names. */
function entryOf(starts, keys) {
    for (const key of keys) {
        const start = starts?.get(key);
        if (start !== undefined) {
            return start;
        }
    }
    return undefined;
}
/** The start on `day` for `keys`: that day's entry, else the newest earlier day's; undefined when no day up to it names them. */
export function scheduledStartOn(schedule, keys, day) {
    const own = entryOf(schedule.days.get(day), keys);
    if (own !== undefined) {
        return { start: own, source: 'schedule' };
    }
    const earlier = [...schedule.days.keys()].filter((written) => written < day).sort().reverse();
    for (const written of earlier) {
        const start = entryOf(schedule.days.get(written), keys);
        if (start !== undefined) {
            return { start, source: 'repeat' };
        }
    }
    return undefined;
}
/** Every key's start on `day`, by key: each key's entry on that day, else on the newest earlier day naming it. */
export function startsOn(schedule, day) {
    const entries = new Map();
    for (const written of [...schedule.days.keys()].filter((each) => each <= day).sort()) {
        for (const [key, start] of schedule.days.get(written) ?? []) {
            entries.set(key, { key, start, writtenOn: written });
        }
    }
    return [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
}
/** The epoch ms of `start` on `day`; undefined for none. */
function startAtOn(day, start) {
    return start.kind === 'none' ? undefined : Date.parse(`${day}T00:00:00.000Z`) + start.minute * MS_PER_MINUTE;
}
/**
 * The day start for `keys` at `now` (see the file's comment): with no schedule entry for them up to today, the
 * team's `wake.dayStartUtc` as before (`fallbackUtc`; none when unset). The next start is today's when still to come,
 * else tomorrow's; a tomorrow with no start rechecks at the start of the day after, when the schedule may say more.
 */
export function resolveDayStart(schedule, keys, fallbackUtc, now) {
    const today = scheduleDayOf(now);
    const own = schedule === undefined ? undefined : scheduledStartOn(schedule, keys, today);
    if (schedule === undefined || own === undefined) {
        return fallbackUtc === undefined
            ? { at: undefined, next: undefined, source: 'config' }
            : { at: dayStartAt(fallbackUtc, now), next: nextDayStartAt(fallbackUtc, now), source: 'config' };
    }
    const todayAt = startAtOn(today, own.start);
    if (todayAt !== undefined && todayAt > now) {
        return { at: undefined, next: todayAt, source: own.source };
    }
    const tomorrow = scheduleDayOf(now - (now % MS_PER_DAY) + MS_PER_DAY);
    const after = scheduledStartOn(schedule, keys, tomorrow);
    const tomorrowAt = after === undefined ? undefined : startAtOn(tomorrow, after.start);
    return { at: todayAt, next: tomorrowAt ?? now - (now % MS_PER_DAY) + 2 * MS_PER_DAY, source: own.source };
}
