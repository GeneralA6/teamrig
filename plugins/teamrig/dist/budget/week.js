import { formatUtcDay, formatUtcHour, MS_PER_DAY, MS_PER_HOUR } from "../core/time.js";
import { DailyProfile } from "./active-time.js";
import { FRESH_READING_MS, useAtW } from "./calibration.js";
import { pastLimitOf, poolOf } from "./extra.js";
import { dailyAllowancePct, dayPacePct, paceLinePct, readPace, spanAllowancePct, weekWindow, } from "./pace.js";
/**
 * The points of the week today's use must span, read from the status line, before its own W per percent prices the
 * sessions' parts of it (`WeekReading.todayWPerPct`): over a narrower span, a small error in it would swing that rate.
 */
export const TODAY_RATE_SPAN_PTS = 2;
/**
 * How far today's own W per percent may stray from the week's, either way, and still price the sessions' parts of
 * today (`WeekReading.todayWPerPct`): past it, the status line's points today and the W metered today disagree, as
 * when the day was read between readings on another team's W scale (T1669), and the week's rate prices the day.
 */
export const TODAY_RATE_MAX_RATIO = 2;
/**
 * The span whose rise the week's run-out forecast carries to the reset (`WeekReading.forecast`): a whole day, so its
 * quiet hours are in it and the rise is a day's, not a busy stretch's.
 */
export const FORECAST_SPAN_MS = MS_PER_DAY;
/**
 * The week's use now read from the meter log (`useAtW`), held to the status line's: at least its percent, and below
 * the next while its reading is fresh, as it shows the next the moment the use reaches it. Not at 100%, where the
 * status line stops and the use goes on into the extra-usage pool.
 */
function heldToStatus(readPct, statusUse, now) {
    const atLeast = Math.max(readPct, statusUse.usedPct);
    const fresh = now - statusUse.at <= FRESH_READING_MS && statusUse.usedPct < 100;
    return fresh ? Math.min(atLeast, Math.floor(statusUse.usedPct) + 1) : atLeast;
}
/**
 * The week's use now on the status line's scale (T531): read between the period's meter readings (`useAtW`), so a rate
 * only prices the part of a percent past the last reading, and held to the status line's (`heldToStatus`). Undefined
 * while the period has no reading or the stores do not reach its start.
 */
function useNowOf(sight) {
    const { readings, start, covered, statusUse, weekW, wPerPct, now } = sight;
    if (start === undefined || !covered || !readings.some((reading) => reading.start === start)) {
        return undefined;
    }
    const readPct = useAtW(readings, start, weekW, wPerPct);
    return statusUse === undefined ? readPct : heldToStatus(readPct, statusUse, now);
}
/**
 * The week's use at the start of the span whose W is `sinceW` and now (`useNowOf`), the start read between the
 * period's meter readings too, so a rate that drifts through the week does not inflate the span. Undefined with the
 * use now.
 */
function statusRiseOf(sight, sinceW) {
    const nowPct = useNowOf(sight);
    const { readings, start, weekW, wPerPct } = sight;
    return nowPct === undefined || start === undefined ? undefined : { fromPct: useAtW(readings, start, weekW - sinceW, wPerPct), nowPct };
}
/**
 * Today's use from the status line, in percent of the week: the rise since today's start, whose W is `todayW`
 * (`statusRiseOf`). Undefined with that rise: today's use is then its W at the week's rate.
 */
function statusTodayPct(sight, todayW) {
    const rise = statusRiseOf(sight, todayW);
    return rise === undefined ? undefined : Math.max(0, rise.nowPct - rise.fromPct);
}
/**
 * The week's run-out forecast (T1706): the status line's rise over the last `FORECAST_SPAN_MS`, whose W is `spanW`
 * (`statusRiseOf`), carried at that rate to the reset. `wSince` counts the span from its start's whole hour, so the
 * rise errs high and the week runs out sooner, never later. Undefined in the period's first day, at or past the reset,
 * at 100% (where the extra-usage pool's line takes over) and while the rise is unknown.
 */
function forecastOf(sight, reset, spanW) {
    const { start, now } = sight;
    if (start === undefined || now - FORECAST_SPAN_MS < start || now >= reset) {
        return undefined;
    }
    const rise = statusRiseOf(sight, spanW);
    if (rise === undefined || rise.nowPct >= 100) {
        return undefined;
    }
    const risePts = Math.max(0, rise.nowPct - rise.fromPct);
    const endPct = rise.nowPct + (risePts * (reset - now)) / FORECAST_SPAN_MS;
    return { risePts, endPct, fullAt: endPct < 100 ? undefined : now + ((100 - rise.nowPct) / risePts) * FORECAST_SPAN_MS };
}
/**
 * Everyone's W from the hour of `from` to `now`: the whole days after `from`'s UTC day and, on that day,
 * its W less its hours before `from`'s hour, which counts whole. A store whose hours were lost (an older
 * teamrig rewrote it) keeps them in, so its W errs high, never low.
 */
export function wSince(states, from, now) {
    const fromDay = formatUtcDay(new Date(from));
    const fromHour = formatUtcHour(new Date(from));
    const today = formatUtcDay(new Date(now));
    let total = 0;
    for (const state of states) {
        let before = 0;
        for (const [hour, w] of Object.entries(state.byHour)) {
            before += hour.startsWith(fromDay) && hour < fromHour ? w : 0;
        }
        for (const [day, usage] of Object.entries(state.byDay)) {
            total += day === fromDay ? Math.max(0, usage.w - before) : day > fromDay && day <= today ? usage.w : 0;
        }
    }
    return total;
}
/**
 * Everyone's W from the hour of `from` to `now` that fell in inactive time: each hour's W times the part of that hour
 * the profile does not count as active, so a quiet hour's whole W at the default `paceWeight` of 0. It counts `from`'s
 * hour whole, as `wSince` does. A store whose hours were lost adds nothing, so the in-day pace errs low.
 */
export function idleWSince(states, from, now, profile) {
    let total = 0;
    for (let hour = from - (from % MS_PER_HOUR); hour <= now; hour += MS_PER_HOUR) {
        const idleShare = 1 - profile.activeMs(hour, hour + MS_PER_HOUR) / MS_PER_HOUR;
        if (idleShare <= 0) {
            continue;
        }
        const key = formatUtcHour(new Date(hour));
        for (const state of states) {
            total += (state.byHour[key] ?? 0) * idleShare;
        }
    }
    return total;
}
/** W per percent of the week from `budget.weeklyLimitW`; undefined without it. */
export function limitWPerPct(budget) {
    return budget.weeklyLimitW === undefined ? undefined : budget.weeklyLimitW / 100;
}
/** The usage stores' W for the period's inference (budget/period.ts) at `wPerPct`; undefined without it. */
export function meteredOf(wPerPct, states, now) {
    return wPerPct === undefined ? undefined : { wPerPct, wFrom: (from) => wSince(states, from, now) };
}
/** The week's W per percent and where it comes from (`RateSource`), first that is known; undefined while none is. */
export function rateOf(calibration, budget, estimate) {
    if (calibration.fit !== undefined) {
        return { wPerPct: calibration.fit.wPerPct, from: 'learned' };
    }
    const limit = limitWPerPct(budget);
    if (limit !== undefined) {
        return { wPerPct: limit, from: 'limit' };
    }
    return estimate === undefined ? undefined : { wPerPct: estimate, from: 'estimate' };
}
/** Whether the usage stores reach back to `from`: the earliest UTC day any of them counted is `from`'s day or before. */
export function coversFrom(states, from) {
    const first = states.flatMap((state) => Object.keys(state.byDay)).sort()[0];
    return first !== undefined && first <= formatUtcDay(new Date(from));
}
/**
 * W per percent of today's use (`WeekReading.todayWPerPct`): today's W over its points read from the status line, once
 * they span `TODAY_RATE_SPAN_PTS` and that rate is within `TODAY_RATE_MAX_RATIO` of the week's, else the week's.
 */
function todayRateOf(todayW, statusToday, wPerPct) {
    if (wPerPct === undefined || statusToday === undefined || statusToday < TODAY_RATE_SPAN_PTS) {
        return wPerPct;
    }
    const rate = todayW / statusToday;
    return rate >= wPerPct / TODAY_RATE_MAX_RATIO && rate <= wPerPct * TODAY_RATE_MAX_RATIO ? rate : wPerPct;
}
/**
 * The team's allowance today: the week's, to its target (`dailyAllowancePct`); at or past 100% of the week, the W the
 * extra-usage pool still holds, spread over the active time to the pace end like the week's, so the pool lasts to the
 * reset instead of going in a day. Recomputed at every reading as the pool is spent; none with the pool empty.
 */
function teamAllowancePct(input, pool, wPerPct) {
    const leftW = pastLimitOf(input.usedPct, pool) === 'pool' ? pool?.leftW : undefined;
    if (leftW === undefined) {
        return dailyAllowancePct(input);
    }
    const { window, now, usedPct, todayPct, profile } = input;
    return spanAllowancePct({ start: window.start, end: window.paceEnd, stopPct: usedPct + leftW / wPerPct, now, usedPct, todayPct, profile });
}
export function readWeek(input) {
    const { budget, now, statusUse, states, period, calibration, readings, extra } = input;
    const reset = period?.end;
    const window = period === undefined ? undefined : weekWindow(period.end, budget.paceEndHoursBeforeReset, period.start);
    const dayStart = now - (now % MS_PER_DAY);
    const todayFrom = window === undefined ? dayStart : Math.max(dayStart, window.start);
    const todayW = wSince(states, todayFrom, now);
    const covered = window !== undefined && coversFrom(states, window.start);
    const weekW = window === undefined ? 0 : wSince(states, window.start, now);
    const estimate = statusUse !== undefined && covered && weekW > 0 && statusUse.usedPct > 0 ? weekW / statusUse.usedPct : undefined;
    const rate = rateOf(calibration, budget, estimate);
    const wPerPct = rate?.wPerPct;
    const usedPct = statusUse?.usedPct ?? (covered && wPerPct !== undefined ? weekW / wPerPct : undefined);
    const sight = wPerPct === undefined ? undefined : { readings, start: period?.start, covered, statusUse, weekW, wPerPct, now };
    const statusToday = sight === undefined ? undefined : statusTodayPct(sight, todayW);
    const todayPct = statusToday ?? (wPerPct === undefined ? undefined : todayW / wPerPct);
    const todayWPerPct = todayRateOf(todayW, statusToday, wPerPct);
    const useNow = sight === undefined ? undefined : useNowOf(sight);
    const usedWPerPct = useNow === undefined || useNow <= 0 || weekW <= 0 ? wPerPct : weekW / useNow;
    const profile = DailyProfile.ofQuietHours(budget.quietHours);
    const pace = window === undefined || usedPct === undefined ? undefined : readPace(window, budget, now, usedPct, profile);
    const plannedPct = window === undefined ? undefined : paceLinePct(window, budget.targetPct, dayStart + MS_PER_DAY, profile) - paceLinePct(window, budget.targetPct, todayFrom, profile);
    const pool = extra === undefined || window === undefined || usedPct === undefined
        ? undefined
        : poolOf(extra.entries, { start: window.start, w: weekW, usedPct, wAtFull: extra.wAtFull, configuredWPerUsd: budget.extraWPerUsd });
    const allowancePct = window === undefined || usedPct === undefined || wPerPct === undefined || todayPct === undefined
        ? undefined
        : teamAllowancePct({ window, budget, now, usedPct, todayPct, profile }, pool, wPerPct);
    const pastLimit = usedPct === undefined ? undefined : pastLimitOf(usedPct, pool);
    const teamDay = window === undefined || todayPct === undefined || todayWPerPct === undefined || allowancePct === undefined
        ? undefined
        : {
            usedPct: todayPct,
            pacePct: dayPacePct({ window, now, allowancePct, idlePct: idleWSince(states, todayFrom, now, profile) / todayWPerPct, profile }),
            ...(pastLimit === undefined ? {} : { pastLimit }),
        };
    return {
        reset,
        window,
        periodKind: period?.kind,
        usedPct,
        statusAt: statusUse?.at,
        wPerPct,
        rateFrom: rate?.from,
        calibration,
        covered,
        pace,
        allowancePct,
        plannedPct,
        todayFrom,
        todayW,
        todayWPerPct,
        usedWPerPct,
        teamDay,
        pool,
        forecast: sight === undefined || reset === undefined ? undefined : forecastOf(sight, reset, wSince(states, now - FORECAST_SPAN_MS, now)),
    };
}
