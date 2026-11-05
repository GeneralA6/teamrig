import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { isRecord, numberField } from '../core/guards.ts';
import { parseObject, recordVersion, VERSION_FIELD, writableObject } from '../core/jsonl.ts';
import { mergeWeekFolds, readSnapshots, weekFoldOf, type StatusSnapshot, type WeekFold, type WeekUse } from './snapshot.ts';

/**
 * The week summary: a snapshot folder's readings of the week folded into one (`weekFoldOf`), kept beside them as
 * `<snapshot folder>/.week` by `teamrig statusline`, so a reader opens one small file instead of every snapshot
 * in the folder, which each hook of each tab reads. The format, one JSON object:
 *
 * - `v`: `WEEK_SUMMARY_FORMAT`;
 * - `reading`: null, or `{ used_percentage, resets_at, at, after }`: the reading that counts, its reset in epoch
 *   seconds, by when it was taken, ISO 8601 UTC, and after when, the same or null when not known;
 * - `followed_by`: the latest time a folded reading is known to have been taken after, ISO 8601 UTC, or null.
 *
 * Its name is not a `.json` one, so no reader takes it for a snapshot.
 */
export const WEEK_SUMMARY_FILE = '.week';

/** The week summary's format; a field added to it raises this. */
export const WEEK_SUMMARY_FORMAT = 2;

const MS_PER_SECOND = 1000;

function timeToStore(at: number | undefined): string | null {
  return at === undefined ? null : new Date(at).toISOString();
}

/** The fold as the summary file's text. */
export function formatWeekSummary(fold: WeekFold): string {
  const { best, followedBy } = fold;
  return JSON.stringify({
    [VERSION_FIELD]: WEEK_SUMMARY_FORMAT,
    reading:
      best === undefined
        ? null
        : { used_percentage: best.usedPct, resets_at: Math.round(best.resetsAt / MS_PER_SECOND), at: timeToStore(best.at), after: timeToStore(best.after) },
    followed_by: timeToStore(followedBy),
  });
}

/** A time stored as ISO 8601: null for none, undefined when it is neither a time nor null. */
function storedTime(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? undefined : at;
}

/** The stored reading: null for none, undefined when it is damaged. */
function storedReading(value: unknown): WeekUse | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const usedPct = numberField(value, 'used_percentage');
  const resetsAt = numberField(value, 'resets_at');
  const at = storedTime(value['at']);
  const after = storedTime(value['after']);
  if (usedPct === undefined || resetsAt === undefined || typeof at !== 'number' || after === undefined) {
    return undefined;
  }
  const use: WeekUse = { usedPct, resetsAt: resetsAt * MS_PER_SECOND, at };
  return after === null ? use : { ...use, after };
}

/** The summary file's text; undefined when it is damaged or in a format this teamrig cannot read. */
export function parseWeekSummary(text: string): WeekFold | undefined {
  const parsed = parseObject(text);
  const stored = parsed !== undefined && recordVersion(parsed) === WEEK_SUMMARY_FORMAT ? parsed : undefined;
  const best = stored === undefined ? undefined : storedReading(stored['reading']);
  const followedBy = stored === undefined ? undefined : storedTime(stored['followed_by']);
  if (best === undefined || followedBy === undefined) {
    return undefined;
  }
  return { best: best ?? undefined, followedBy: followedBy ?? undefined };
}

/**
 * The folder's readings of the week, folded: its summary when it holds a sound one, else every snapshot in it
 * (`weekFoldOf` at `now`), as for a folder only another make of status line writes, or one no `teamrig statusline`
 * has written to since it began to keep the summary.
 */
export async function readFolderWeek(files: Pick<Files, 'list' | 'read'>, dir: string, now: number): Promise<WeekFold> {
  const text = await files.read(join(dir, WEEK_SUMMARY_FILE));
  const kept = text === undefined ? undefined : parseWeekSummary(text);
  return kept ?? weekFoldOf(await readSnapshots(files, dir), now);
}

/**
 * Folds a snapshot just saved in the folder into its summary, written only when that changes it. A missing or
 * damaged summary is first rebuilt from every snapshot in the folder. Two status lines that fold at once may lose
 * one's reading (the later write wins); that session's next status line run folds it again, and a week's use only
 * grows, so any later reading is at least as high. Returns whether it wrote the summary. A summary a newer teamrig
 * wrote is refused (`NewerDataError`), never overwritten.
 */
export async function foldIntoWeekSummary(files: Pick<Files, 'list' | 'read' | 'write'>, dir: string, snapshot: StatusSnapshot, now: number): Promise<boolean> {
  const path = join(dir, WEEK_SUMMARY_FILE);
  const text = await files.read(path);
  writableObject(path, text, WEEK_SUMMARY_FORMAT);
  const kept = (text === undefined ? undefined : parseWeekSummary(text)) ?? weekFoldOf(await readSnapshots(files, dir), now);
  const next = formatWeekSummary(mergeWeekFolds(kept, weekFoldOf([snapshot], now)));
  if (next === text) {
    return false;
  }
  await files.write(path, next);
  return true;
}
