import type { Files } from '../core/files.ts';
import { formatUtcHour } from '../core/time.ts';
import type { WeekWindow } from './pace.ts';
import { formatSessionsWeek, SESSIONS_WEEK_FORMAT, type SessionsWeekSummary, type SessionWeek } from './session-week-summary.ts';
import type { UsageState } from './store.ts';
import { keepSummaryFile, summaryMinute, summaryPct } from './summary-file.ts';
import { wSince } from './week.ts';

/** What the sessions' week is read from: the week as the budget hooks read it, and each session's own store. */
export interface SessionsWeekInput {
  readonly window: WeekWindow | undefined;
  /** W per percent of the week's use so far (src/budget/week.ts `WeekReading.usedWPerPct`), so the sessions' parts add up to the team's. */
  readonly wPerPct: number | undefined;
  /** Each session on the team's roster and its usage store, in the roster's order. */
  readonly byId: ReadonlyMap<string, UsageState>;
  readonly now: number;
}

/**
 * The UTC hours from `from`'s to `now`'s in which the store counted any W: `from`'s hour whole, as `wSince` counts it.
 * A store whose hours were lost (src/budget/store.ts `byHour`) counts fewer.
 */
export function workHoursSince(state: UsageState, from: number, now: number): number {
  const first = formatUtcHour(new Date(from));
  const last = formatUtcHour(new Date(now));
  return Object.entries(state.byHour).filter(([hour, w]) => w > 0 && hour >= first && hour <= last).length;
}

/**
 * The sessions' week (src/budget/session-week-summary.ts): each roster session's W since the week began at the week's
 * used rate (`wPerPct`), and its hours with work since then; undefined while the week or the rate is unknown.
 */
export function sessionsWeekOf(input: SessionsWeekInput): SessionsWeekSummary | undefined {
  const { window, wPerPct, now } = input;
  if (window === undefined || wPerPct === undefined || wPerPct <= 0) {
    return undefined;
  }
  const sessions = [...input.byId].map(([id, state]): [string, SessionWeek] => [
    id,
    { usedPct: summaryPct(wSince([state], window.start, now) / wPerPct), workHours: workHoursSince(state, window.start, now) },
  ]);
  return { resetsAt: window.reset, at: summaryMinute(now), sessions: Object.fromEntries(sessions) };
}

/** Writes the sessions' week at `path` when that changes it, as every week summary is kept (`keepSummaryFile`); returns whether it wrote. */
export async function keepSessionsWeek(files: Pick<Files, 'read' | 'write'>, path: string, summary: SessionsWeekSummary): Promise<boolean> {
  return keepSummaryFile(files, path, formatSessionsWeek(summary), SESSIONS_WEEK_FORMAT);
}
