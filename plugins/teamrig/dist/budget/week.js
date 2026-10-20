import { formatUtcDay, formatUtcHour, MS_PER_DAY } from "../core/time.js";
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
/** W per percent of the week from `budget.weeklyLimitW`; undefined without it. */
export function limitWPerPct(budget) {
    return budget.weeklyLimitW === undefined ? undefined : budget.weeklyLimitW / 100;
}
/** The usage stores' W for the period's inference (budget/period.ts); undefined without `budget.weeklyLimitW`. */
export function meteredOf(budget, states, now) {
    const wPerPct = limitWPerPct(budget);
    return wPerPct === undefined ? undefined : { wPerPct, wFrom: (from) => wSince(states, from, now) };
}
function earliestDay(states) {
    const days = states.flatMap((state) => Object.keys(state.byDay)).sort();
    return days[0];
}
export function readWeek(input) {
    const { budget, now, statusUse, states, period } = input;
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
    const wPerPct = limitWPerPct(budget) ?? estimate;
    const usedPct = statusUse?.usedPct ?? (covered && wPerPct !== undefined ? weekW / wPerPct : undefined);
    const profile = DailyProfile.ofQuietHours(budget.quietHours);
    const pace = window === undefined || usedPct === undefined ? undefined : readPace(window, budget, now, usedPct, profile);
    const allowancePct = window === undefined || usedPct === undefined || wPerPct === undefined
        ? undefined
        : dailyAllowancePct({ window, budget, now, usedPct, todayPct: todayW / wPerPct, profile });
    const teamDay = window === undefined || wPerPct === undefined || allowancePct === undefined
        ? undefined
        : { usedPct: todayW / wPerPct, pacePct: dayPacePct({ window, now, allowancePct, profile }) };
    return {
        reset,
        window,
        periodKind: period?.kind,
        usedPct,
        statusAt: statusUse?.at,
        wPerPct,
        limitEstimated: budget.weeklyLimitW === undefined && wPerPct !== undefined,
        covered,
        pace,
        allowancePct,
        todayFrom,
        todayW,
        teamDay,
    };
}
