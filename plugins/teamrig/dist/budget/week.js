import { formatUtcDay } from "../core/time.js";
import { DailyProfile } from "./active-time.js";
import { dailyAllowancePct, readPace, resolveReset, weekWindow } from "./pace.js";
function sumW(states, counts) {
    let total = 0;
    for (const state of states) {
        for (const [day, usage] of Object.entries(state.byDay)) {
            total += counts(day) ? usage.w : 0;
        }
    }
    return total;
}
function earliestDay(states) {
    const days = states.flatMap((state) => Object.keys(state.byDay)).sort();
    return days[0];
}
export function readWeek(input) {
    const { budget, now, statusUse, states } = input;
    const reset = resolveReset(now, statusUse?.resetsAt, budget.reset);
    const window = reset === undefined ? undefined : weekWindow(reset, budget.paceEndHoursBeforeReset);
    const today = formatUtcDay(new Date(now));
    const todayW = sumW(states, (day) => day === today);
    const startDay = window === undefined ? undefined : formatUtcDay(new Date(window.start));
    const first = earliestDay(states);
    const covered = startDay !== undefined && first !== undefined && first <= startDay;
    const weekW = startDay === undefined ? 0 : sumW(states, (day) => day >= startDay && day <= today);
    const estimate = statusUse !== undefined && covered && weekW > 0 && statusUse.usedPct > 0 ? weekW / statusUse.usedPct : undefined;
    const wPerPct = budget.weeklyLimitW === undefined ? estimate : budget.weeklyLimitW / 100;
    const usedPct = statusUse?.usedPct ?? (covered && wPerPct !== undefined ? weekW / wPerPct : undefined);
    const profile = DailyProfile.ofQuietHours(budget.quietHours);
    const pace = window === undefined || usedPct === undefined ? undefined : readPace(window, budget, now, usedPct, profile);
    const allowancePct = window === undefined || usedPct === undefined || wPerPct === undefined
        ? undefined
        : dailyAllowancePct({ window, budget, now, usedPct, todayPct: todayW / wPerPct, profile });
    return {
        reset,
        window,
        usedPct,
        statusAt: statusUse?.at,
        wPerPct,
        limitEstimated: budget.weeklyLimitW === undefined && wPerPct !== undefined,
        covered,
        pace,
        allowancePct,
        todayW,
    };
}
