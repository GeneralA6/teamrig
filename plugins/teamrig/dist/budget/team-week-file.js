import { teamShareOf } from "./parts.js";
import { keepSummaryFile, summaryMinute, summaryPct } from "./summary-file.js";
import { formatTeamWeek, TEAM_WEEK_FORMAT } from "./team-week-summary.js";
import { wSince } from "./week.js";
/**
 * The team's week summary (src/budget/team-week-summary.ts): its sessions' W since the week began at its own rate,
 * and that plus its part of what the account has left to the target (the split as is, as a surplus reads it: no day's
 * funding); undefined while the week, its use or the rate is unknown.
 */
export function teamWeekSummaryOf(input) {
    const { window, usedPct, wPerPct, now } = input;
    if (window === undefined || usedPct === undefined || wPerPct === undefined || wPerPct <= 0) {
        return undefined;
    }
    const teamUsedPct = wSince(input.states, window.start, now) / wPerPct;
    const leftPct = teamShareOf(Math.max(0, input.targetPct - usedPct), input.teams.split, input.teams.others);
    return {
        usedPct: summaryPct(teamUsedPct),
        plannedPct: summaryPct(teamUsedPct + leftPct),
        accountUsedPct: summaryPct(usedPct),
        resetsAt: window.reset,
        at: summaryMinute(now),
    };
}
/** Writes the team's week summary at `path` when that changes it, as every week summary is kept (`keepSummaryFile`); returns whether it wrote. */
export async function keepTeamWeek(files, path, summary) {
    return keepSummaryFile(files, path, formatTeamWeek(summary), TEAM_WEEK_FORMAT);
}
