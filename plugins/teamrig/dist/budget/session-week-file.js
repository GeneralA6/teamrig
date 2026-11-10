import { formatUtcHour } from "../core/time.js";
import { formatSessionsWeek, SESSIONS_WEEK_FORMAT } from "./session-week-summary.js";
import { keepSummaryFile, summaryMinute, summaryPct } from "./summary-file.js";
import { wSince } from "./week.js";
/**
 * The UTC hours from `from`'s to `now`'s in which the store counted any W: `from`'s hour whole, as `wSince` counts it.
 * A store whose hours were lost (src/budget/store.ts `byHour`) counts fewer.
 */
export function workHoursSince(state, from, now) {
    const first = formatUtcHour(new Date(from));
    const last = formatUtcHour(new Date(now));
    return Object.entries(state.byHour).filter(([hour, w]) => w > 0 && hour >= first && hour <= last).length;
}
/**
 * The sessions' week (src/budget/session-week-summary.ts): each roster session's W since the week began at the week's
 * used rate (`wPerPct`), and its hours with work since then; undefined while the week or the rate is unknown.
 */
export function sessionsWeekOf(input) {
    const { window, wPerPct, now } = input;
    if (window === undefined || wPerPct === undefined || wPerPct <= 0) {
        return undefined;
    }
    const sessions = [...input.byId].map(([id, state]) => [
        id,
        { usedPct: summaryPct(wSince([state], window.start, now) / wPerPct), workHours: workHoursSince(state, window.start, now) },
    ]);
    return { resetsAt: window.reset, at: summaryMinute(now), sessions: Object.fromEntries(sessions) };
}
/** Writes the sessions' week at `path` when that changes it, as every week summary is kept (`keepSummaryFile`); returns whether it wrote. */
export async function keepSessionsWeek(files, path, summary) {
    return keepSummaryFile(files, path, formatSessionsWeek(summary), SESSIONS_WEEK_FORMAT);
}
