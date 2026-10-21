import { formatUtcDay, formatUtcHour, MS_PER_DAY, MS_PER_HOUR } from "../core/time.js";
import { DailyProfile } from "./active-time.js";
import { dailyAllowancePct, dayPacePct, readPace, weekWindow } from "./pace.js";
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
function earliestDay(states) {
    const days = states.flatMap((state) => Object.keys(state.byDay)).sort();
    return days[0];
}
export function readWeek(input) {
    const { budget, now, statusUse, states, period, calibration } = input;
    const reset = period?.end;
    const window = period === undefined ? undefined : weekWindow(period.end, budget.paceEndHoursBeforeReset, period.start);
    const dayStart = now - (now % MS_PER_DAY);
    const todayFrom = window === undefined ? dayStart : Math.max(dayStart, window.start);
    const todayW = wSince(states, todayFrom, now);
    const startDay = window === undefined ? undefined : formatUtcDay(new Date(window.start));
    const first = earliestDay(states);
    const covered = startDay !== undefined && first !== undefined && first <= startDay;
    const weekW = window === undefined ? 0 : wSince(states, window.start, now);
    const estimate = statusUse !== undefined && covered && weekW > 0 && statusUse.usedPct > 0 ? weekW / statusUse.usedPct : undefined;
    const rate = rateOf(calibration, budget, estimate);
    const wPerPct = rate?.wPerPct;
    const usedPct = statusUse?.usedPct ?? (covered && wPerPct !== undefined ? weekW / wPerPct : undefined);
    const profile = DailyProfile.ofQuietHours(budget.quietHours);
    const pace = window === undefined || usedPct === undefined ? undefined : readPace(window, budget, now, usedPct, profile);
    const allowancePct = window === undefined || usedPct === undefined || wPerPct === undefined
        ? undefined
        : dailyAllowancePct({ window, budget, now, usedPct, todayPct: todayW / wPerPct, profile });
    const teamDay = window === undefined || wPerPct === undefined || allowancePct === undefined
        ? undefined
        : { usedPct: todayW / wPerPct, pacePct: dayPacePct({ window, now, allowancePct, idlePct: idleWSince(states, todayFrom, now, profile) / wPerPct, profile }) };
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
        todayFrom,
        todayW,
        teamDay,
    };
}
