import { isRecord, numberField, recordField } from '../core/guards.ts';
import { parseObject, recordVersion, VERSION_FIELD } from '../core/jsonl.ts';
import { isItemType } from '../register/events.ts';
import type { LikeMedian, StoredSpend } from '../register/ranking.ts';

/**
 * What each task has cost, kept by the budget hooks (src/budget/task-week-file.ts) for a reader that ranks tasks
 * without metering them, as the pane's lists do: a task with no size is scored on its spend, and turning W into percent
 * takes the account's meter log, which no reader through src/read has. One file per team, beside its week summary
 * (src/budget/team-week-summary.ts), at `TASKS_WEEK_IN_STATE` under the team's state folder (`<kit
 * home>/teams/<team>/state`, unless the team config's `paths.state` moves it); the format, one JSON object:
 *
 * - `v`: `TASKS_WEEK_FORMAT`;
 * - `at`: when it was read, epoch ms, to the minute;
 * - `spentPct`: each task the team's sessions spent W on, by its id, in id order: the W the meter keeps on it, the use
 *   outside the team's sessions included, at the team's own W per percent. A task with a size base counts only from
 *   that base (src/budget/task-use.ts `spentSince`), as the ranking does, so a reader scores it as `teamrig list` does.
 *   A task with no spend, or a sized one with none since its base, has no entry.
 * - `likeMedians`: the median spend of each kind of task done inside the like window, `{ workClass, type, pct }` by
 *   class and then type, an unset type (null) first, as `teamrig list` sizes an unsized task by them
 *   (src/register/ranking.ts `likeMedians`): each task's whole cost, its size base aside, at the same rate. A reader
 *   sizes by them (`storedSizing`) and never works them out again, as its own hold of the meter keeps fewer days.
 *
 * A hook of any of the team's sessions rewrites the file when that changes it. Format 1 had no `likeMedians` and reads
 * as no file, unlike most stores' older formats: a reader sizing without the medians would rank unsized tasks apart
 * from `teamrig list`, and the next turn's hook writes format 2 over it (src/budget/summary-file.ts `keepSummaryFile`).
 */
export const TASKS_WEEK_IN_STATE = ['usage', 'tasks.week.json'] as const;

/** The tasks' week file's format; a field added to it raises this. */
export const TASKS_WEEK_FORMAT = 2;

/** The team's tasks' spend as the file holds it, read as `storedSizing` sizes by it. */
export interface TasksWeekSummary extends StoredSpend {
  readonly at: number;
  /** By task id, in id order. */
  readonly spentPct: Readonly<Record<string, number>>;
}

/** The summary as its file's text. */
export function formatTasksWeek(summary: TasksWeekSummary): string {
  const { at, spentPct, likeMedians } = summary;
  return JSON.stringify({ [VERSION_FIELD]: TASKS_WEEK_FORMAT, at, spentPct, likeMedians: likeMedians.map(({ workClass, type, pct }) => ({ workClass, type, pct })) });
}

/** What a stored median reads as: the median, none for a type this teamrig does not know (a newer one's), or damaged. */
type StoredMedian = LikeMedian | 'unknown type' | undefined;

/**
 * A stored median. One of a type a newer teamrig writes is left out: this teamrig reads that type's tasks as tasks
 * (src/register/events.ts), which have a median of their own.
 */
function storedMedian(value: unknown): StoredMedian {
  if (!isRecord(value)) {
    return undefined;
  }
  const { workClass, type, pct } = value;
  if (typeof workClass !== 'string' || workClass === '' || typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0 || (type !== null && typeof type !== 'string')) {
    return undefined;
  }
  if (type === null || isItemType(type)) {
    return { workClass, type, pct };
  }
  return 'unknown type';
}

/** The stored medians; undefined when the value is not a list of them or one is damaged. */
function storedMedians(value: unknown): readonly LikeMedian[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const medians: LikeMedian[] = [];
  for (const stored of value) {
    const median = storedMedian(stored);
    if (median === undefined) {
      return undefined;
    }
    if (median !== 'unknown type') {
      medians.push(median);
    }
  }
  return medians;
}

/** The file's text; undefined when it is damaged, a task's entry or a median included, or in a format this teamrig cannot read. */
export function parseTasksWeek(text: string): TasksWeekSummary | undefined {
  const parsed = parseObject(text);
  if (parsed === undefined || recordVersion(parsed) !== TASKS_WEEK_FORMAT) {
    return undefined;
  }
  const at = numberField(parsed, 'at');
  const stored = recordField(parsed, 'spentPct');
  const likeMedians = storedMedians(parsed['likeMedians']);
  if (at === undefined || stored === undefined || likeMedians === undefined) {
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
  return { at, spentPct: Object.fromEntries(spentPct), likeMedians };
}
