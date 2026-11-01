import { parseObject, recordVersion } from "../core/jsonl.js";
import { MS_PER_MINUTE } from "../core/time.js";
import { teamShareOf } from "./parts.js";
import { formatTeamWeek, TEAM_WEEK_FORMAT } from "./team-week-summary.js";
import { wSince } from "./week.js";
const HUNDREDTHS = 100;
function hundredths(pct) {
    return Math.round(pct * HUNDREDTHS) / HUNDREDTHS;
}
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
        usedPct: hundredths(teamUsedPct),
        plannedPct: hundredths(teamUsedPct + leftPct),
        accountUsedPct: hundredths(usedPct),
        resetsAt: window.reset,
        at: now - (now % MS_PER_MINUTE),
    };
}
/**
 * Writes the team's week summary at `path` when that changes it; returns whether it wrote. Several tabs may write it
 * at once and the last write wins: each reads the same week, and the next hook writes it again. A summary a newer
 * teamrig wrote is left as it is, without failing the hook: the file is only for display.
 */
export async function keepTeamWeek(files, path, summary) {
    const text = await files.read(path);
    const stored = text === undefined ? undefined : parseObject(text);
    const version = stored === undefined ? undefined : recordVersion(stored);
    const next = formatTeamWeek(summary);
    if ((version !== undefined && version > TEAM_WEEK_FORMAT) || next === text) {
        return false;
    }
    await files.write(path, next);
    return true;
}
