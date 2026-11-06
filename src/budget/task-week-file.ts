import type { Files } from '../core/files.ts';
import type { UsageState } from './store.ts';
import { keepSummaryFile, summaryMinute } from './summary-file.ts';
import { taskWOf } from './task-use.ts';
import { formatTasksWeek, TASKS_WEEK_FORMAT, type TasksWeekSummary } from './task-week-summary.ts';

/** A task's percent holds four decimals, finer than a week summary's two: most tasks cost well under a tenth of a percent. */
const SPENT_PCT_SCALE = 10_000;

/** What the tasks' spend is read from: the team's rate, as the budget hooks read it, and the stores `taskWOf` sums. */
export interface TasksWeekInput {
  /** The team's own W per percent of the week. */
  readonly wPerPct: number | undefined;
  /** Each roster session's usage store and the use outside the team, as `readTaskSpend` (src/cli/task-spend.ts) sums them. */
  readonly states: Iterable<UsageState>;
  readonly now: number;
}

/**
 * Rounded up: a task that spent anything must never read 0, since a score takes no spend to mean none measured and falls
 * back to like tasks' median (src/register/score.ts `sizePctOf`).
 */
function spentPctOf(w: number, wPerPct: number): number {
  return Math.ceil((w / wPerPct) * SPENT_PCT_SCALE) / SPENT_PCT_SCALE;
}

/**
 * The tasks' spend (src/budget/task-week-summary.ts) at the team's own rate, by task id; undefined while the rate is
 * unknown. The ids are sorted so that a hook reading the stores in another order writes the same text.
 */
export function tasksWeekOf(input: TasksWeekInput): TasksWeekSummary | undefined {
  const { wPerPct, now } = input;
  if (wPerPct === undefined || wPerPct <= 0) {
    return undefined;
  }
  const spent = [...taskWOf(input.states)]
    .filter(([, w]) => w > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([task, w]): [string, number] => [task, spentPctOf(w, wPerPct)]);
  return { at: summaryMinute(now), spentPct: Object.fromEntries(spent) };
}

/** Writes the tasks' spend at `path` when that changes it, as every week summary is kept (`keepSummaryFile`); returns whether it wrote. */
export async function keepTasksWeek(files: Pick<Files, 'read' | 'write'>, path: string, summary: TasksWeekSummary): Promise<boolean> {
  return keepSummaryFile(files, path, formatTasksWeek(summary), TASKS_WEEK_FORMAT);
}
