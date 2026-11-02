import { WEEKDAYS } from "../config/types.js";
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_WEEK } from "../core/time.js";
import { DailyProfile } from "./active-time.js";
/** The first reset strictly after `now` on the config's weekday and UTC time. */
export function nextConfiguredReset(now, reset) {
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
export function resolveReset(now, fromStatus, configured) {
    if (fromStatus !== undefined && fromStatus > now) {
        return fromStatus;
    }
    return configured === undefined ? undefined : nextConfiguredReset(now, configured);
}
/** The span from `start` (by default the week before) to `reset`, its pace line ending `paceEndHoursBeforeReset` hours before the reset. */
export function weekWindow(reset, paceEndHoursBeforeReset, start = reset - MS_PER_WEEK) {
    return { start, reset, paceEnd: Math.max(start, reset - paceEndHoursBeforeReset * MS_PER_HOUR) };
}
/**
 * Where the pace line stands at `at`: 0 at the week's start, rising with the active time (`profile`) to the target at
 * the pace end, then flat; so it stays flat through the hours the team sleeps. A pace span with no active time rises
 * evenly with clock time instead.
 */
export function paceLinePct(window, targetPct, at, profile) {
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
/**
 * Where the pace line of the week resetting at `reset` stands at `now`, the week taken as the seven days before the
 * reset and its active time from the budget's quiet hours: the status line's cheap reading, which needs no stored
 * period. `teamrig budget` counts from a reset inside the week instead, once it saw one. Undefined once the week reset.
 */
export function paceLineOfWeek(reset, budget, now) {
    if (reset <= now) {
        return undefined;
    }
    return paceLinePct(weekWindow(reset, budget.paceEndHoursBeforeReset), budget.targetPct, now, DailyProfile.ofQuietHours(budget.quietHours));
}
/**
 * A span's allowance for today, in percent of the week, never a fixed number: recomputed at every reading from what
 * is left to its stop %, spread evenly over the active time from now to its end, times today's active time (the UTC
 * day inside the week and before the end). On pace it holds all day; using less raises it and using more lowers it,
 * and an idle evening does not shrink it. Never above today's use plus what is left, which is all it is past the end
 * or with no active time left before it.
 */
export function spanAllowancePct(span) {
    const { now, profile } = span;
    const leftPct = Math.max(0, span.stopPct - span.usedPct);
    const ceiling = span.todayPct + leftPct;
    const remaining = profile.activeMs(now, span.end);
    if (remaining <= 0) {
        return ceiling;
    }
    const dayStart = now - (now % MS_PER_DAY);
    const today = profile.activeMs(Math.max(dayStart, span.start), Math.min(dayStart + MS_PER_DAY, span.end));
    return Math.min((leftPct * today) / remaining, ceiling);
}
/**
 * The team's allowance for today, in percent of the week: `spanAllowancePct` over the week to its pace end, up to
 * the target, so the team never waits while the week has room.
 */
export function dailyAllowancePct(input) {
    const { window, budget, ...reading } = input;
    return spanAllowancePct({ ...reading, start: window.start, end: window.paceEnd, stopPct: budget.targetPct });
}
/**
 * The team's in-day pace, in percent of the week: today's use in inactive time, plus its allowance times the part of
 * today's active time gone by, today being the UTC day inside the week and before the pace end, as the allowance
 * counts it. With no active time today, the whole allowance. The idle use is paced as it is spent: the allowance is
 * recomputed from what is left, so that use has already lowered it, and holding it against the day too would read a
 * night that sessions worked through quiet hours (a lift exempts them) as a day past its pace until the afternoon.
 */
export function dayPacePct(input) {
    const { window, now, allowancePct, idlePct, profile } = input;
    const dayStart = now - (now % MS_PER_DAY);
    const from = Math.max(dayStart, window.start);
    const to = Math.min(dayStart + MS_PER_DAY, window.paceEnd);
    const today = profile.activeMs(from, to);
    return idlePct + (today > 0 ? (allowancePct * profile.activeMs(from, Math.min(now, to))) / today : allowancePct);
}
/**
 * The team has room today while its use is below its in-day pace: a session past its part then uses room the
 * others have left, so nothing holds it. At or past the pace, a session past its part is held, which keeps the
 * others' parts for them.
 */
export function hasRoom(day) {
    return day.usedPct < day.pacePct;
}
/** The week's use against the pace line; within `paceTolerancePct` points it is on pace. */
export function readPace(window, budget, now, usedPct, profile) {
    const linePct = paceLinePct(window, budget.targetPct, now, profile);
    const gapPts = usedPct - linePct;
    const state = Math.abs(gapPts) <= budget.paceTolerancePct ? 'on pace' : gapPts > 0 ? 'ahead' : 'behind';
    return { window, linePct, gapPts, state };
}
