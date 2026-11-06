import type { Files } from '../core/files.ts';
import { parseObject, recordVersion } from '../core/jsonl.ts';
import { MS_PER_MINUTE } from '../core/time.ts';

/**
 * The week summaries the budget hooks keep for readers that show them (src/budget/team-week-summary.ts,
 * src/budget/session-week-summary.ts, src/budget/task-week-summary.ts): how they round what they hold, a task's spend
 * keeping its own finer scale (src/budget/task-week-file.ts), and how a hook writes one.
 */

const HUNDREDTHS = 100;

/** A percent as a summary holds it: to two decimals. */
export function summaryPct(pct: number): number {
  return Math.round(pct * HUNDREDTHS) / HUNDREDTHS;
}

/** When a summary was read, as it holds it: down to the minute, so a hook in the same minute finds nothing changed. */
export function summaryMinute(now: number): number {
  return now - (now % MS_PER_MINUTE);
}

/**
 * Writes a summary's `text` at `path` when that changes the file; returns whether it wrote. Several tabs may write it
 * at once and the last write wins: each reads the same week, and the next hook writes it again. A file a newer
 * teamrig wrote, past `format`, is left as it is, without failing the hook: the file is only for display. A damaged
 * one is replaced.
 */
export async function keepSummaryFile(files: Pick<Files, 'read' | 'write'>, path: string, text: string, format: number): Promise<boolean> {
  const current = await files.read(path);
  const stored = current === undefined ? undefined : parseObject(current);
  const version = stored === undefined ? undefined : recordVersion(stored);
  if ((version !== undefined && version > format) || text === current) {
    return false;
  }
  await files.write(path, text);
  return true;
}
