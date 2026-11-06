import { keepSummaryFile, summaryMinute } from "./summary-file.js";
import { taskWOf } from "./task-use.js";
import { formatTasksWeek, TASKS_WEEK_FORMAT } from "./task-week-summary.js";
/** A task's percent holds four decimals, finer than a week summary's two: most tasks cost well under a tenth of a percent. */
const SPENT_PCT_SCALE = 10_000;
/**
 * Rounded up: a task that spent anything must never read 0, since a score takes no spend to mean none measured and falls
 * back to like tasks' median (src/register/score.ts `sizePctOf`).
 */
function spentPctOf(w, wPerPct) {
    return Math.ceil((w / wPerPct) * SPENT_PCT_SCALE) / SPENT_PCT_SCALE;
}
/**
 * The tasks' spend (src/budget/task-week-summary.ts) at the team's own rate, by task id; undefined while the rate is
 * unknown. The ids are sorted so that a hook reading the stores in another order writes the same text.
 */
export function tasksWeekOf(input) {
    const { wPerPct, now } = input;
    if (wPerPct === undefined || wPerPct <= 0) {
        return undefined;
    }
    const spent = [...taskWOf(input.states)]
        .filter(([, w]) => w > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([task, w]) => [task, spentPctOf(w, wPerPct)]);
    return { at: summaryMinute(now), spentPct: Object.fromEntries(spent) };
}
/** Writes the tasks' spend at `path` when that changes it, as every week summary is kept (`keepSummaryFile`); returns whether it wrote. */
export async function keepTasksWeek(files, path, summary) {
    return keepSummaryFile(files, path, formatTasksWeek(summary), TASKS_WEEK_FORMAT);
}
