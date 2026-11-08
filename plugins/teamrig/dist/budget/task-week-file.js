import { likeMedians } from "../register/ranking.js";
import { keepSummaryFile, summaryMinute } from "./summary-file.js";
import { spentSince, taskUseReader, taskWOf } from "./task-use.js";
import { formatTasksWeek, TASKS_WEEK_FORMAT } from "./task-week-summary.js";
/** A task's percent holds four decimals, finer than a week summary's two: most tasks cost well under a tenth of a percent. */
const SPENT_PCT_SCALE = 10_000;
/**
 * Rounded up: a task that spent anything must never read 0, since a score takes no spend to mean none measured and falls
 * back to like tasks' median (src/register/score.ts `sizePctOf`), and a median of 0 would fall to the floor.
 */
function ceilPct(pct) {
    return Math.ceil(pct * SPENT_PCT_SCALE) / SPENT_PCT_SCALE;
}
/**
 * The tasks' spend (src/budget/task-week-summary.ts) at the team's own rate, by task id; undefined while the rate is
 * unknown. A sized task counts from its size base, by the `spentSince` the ranking reads it with (src/cli/task-spend.ts),
 * so one with nothing past its base has no entry, as it reads 0 there. The one pass of `taskWOf` serves every other
 * task, and the walk per task only the sized few, since a hook writes this every turn. The ids are sorted so that a hook
 * reading the stores in another order writes the same text. The like medians take each task's whole cost from that same
 * pass, a size base aside, as `teamrig list` takes them (src/cli/team-ranking.ts `likeSizing`).
 */
export function tasksWeekOf(input) {
    const { wPerPct, bySession, bases, likeTasks, focus, now } = input;
    if (wPerPct === undefined || wPerPct <= 0) {
        return undefined;
    }
    const useOf = taskUseReader(bySession);
    const wholeW = taskWOf(bySession.values());
    const spent = [...wholeW]
        .map(([task, w]) => {
        const base = bases.get(task);
        return [task, base === undefined ? w : spentSince(useOf(task), base)];
    })
        .filter(([, w]) => w > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([task, w]) => [task, ceilPct(w / wPerPct)]);
    const medians = likeMedians(likeTasks, focus, (id) => (wholeW.get(id) ?? 0) / wPerPct, now).map((median) => ({ ...median, pct: ceilPct(median.pct) }));
    return { at: summaryMinute(now), spentPct: Object.fromEntries(spent), likeMedians: medians };
}
/** Writes the tasks' spend at `path` when that changes it, as every week summary is kept (`keepSummaryFile`); returns whether it wrote. */
export async function keepTasksWeek(files, path, summary) {
    return keepSummaryFile(files, path, formatTasksWeek(summary), TASKS_WEEK_FORMAT);
}
