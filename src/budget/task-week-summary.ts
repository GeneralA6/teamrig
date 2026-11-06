import { numberField, recordField } from '../core/guards.ts';
import { parseObject, recordVersion, VERSION_FIELD } from '../core/jsonl.ts';

/**
 * What each task has cost, kept by the budget hooks (src/budget/task-week-file.ts) for a reader that ranks tasks
 * without metering them, as the pane's lists do: a task with no size is scored on its spend, and turning W into percent
 * takes the account's meter log, which no reader through src/read has. One file per team, beside its week summary
 * (src/budget/team-week-summary.ts), at `TASKS_WEEK_IN_STATE` under the team's state folder (`<kit
 * home>/teams/<team>/state`, unless the team config's `paths.state` moves it); the format, one JSON object:
 *
 * - `v`: `TASKS_WEEK_FORMAT`;
 * - `at`: when it was read, epoch ms, to the minute;
 * - `spentPct`: each task the team's sessions spent W on, by its id, in id order: all the W the meter keeps on it
 *   (src/budget/task-use.ts `taskWOf`), the use outside the team's sessions included, at the team's own W per percent.
 *   A task with no spend has no entry. This is a task's whole cost, where the ranking counts a task with a size base
 *   only from that base (src/cli/task-spend.ts `spentSince`), so a reader's score for such a task differs from
 *   `teamrig list` (stopgap T2141).
 *
 * A hook of any of the team's sessions rewrites it when that changes it.
 */
export const TASKS_WEEK_IN_STATE = ['usage', 'tasks.week.json'] as const;

/** The tasks' week file's format; a field added to it raises this. */
export const TASKS_WEEK_FORMAT = 1;

/** The team's tasks' spend as the file holds it. */
export interface TasksWeekSummary {
  readonly at: number;
  /** By task id, in id order. */
  readonly spentPct: Readonly<Record<string, number>>;
}

/** The summary as its file's text. */
export function formatTasksWeek(summary: TasksWeekSummary): string {
  const { at, spentPct } = summary;
  return JSON.stringify({ [VERSION_FIELD]: TASKS_WEEK_FORMAT, at, spentPct });
}

/** The file's text; undefined when it is damaged, a task's entry included, or in a format this teamrig cannot read. */
export function parseTasksWeek(text: string): TasksWeekSummary | undefined {
  const parsed = parseObject(text);
  if (parsed === undefined || recordVersion(parsed) !== TASKS_WEEK_FORMAT) {
    return undefined;
  }
  const at = numberField(parsed, 'at');
  const stored = recordField(parsed, 'spentPct');
  if (at === undefined || stored === undefined) {
    return undefined;
  }
  const spentPct: [string, number][] = [];
  for (const id of Object.keys(stored)) {
    const pct = numberField(stored, id);
    if (pct === undefined || pct < 0) {
      return undefined;
    }
    spentPct.push([id, pct]);
  }
  return { at, spentPct: Object.fromEntries(spentPct) };
}
