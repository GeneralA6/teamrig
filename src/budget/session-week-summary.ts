import { isNonNegativeInteger, isRecord, numberField, recordField } from '../core/guards.ts';
import { parseObject, recordVersion, VERSION_FIELD } from '../core/jsonl.ts';

/**
 * Each session's week: its use of the account's week so far and its hours with work, kept by the budget hooks
 * (src/budget/session-week-file.ts) for a reader that shows each session's week without metering it, as the pane's
 * Teams card does. One file per team, beside its week summary (src/budget/team-week-summary.ts), at
 * `SESSIONS_WEEK_IN_STATE` under the team's state folder (`<kit home>/teams/<team>/state`, unless the team config's
 * `paths.state` moves it); the format, one JSON object:
 *
 * - `v`: `SESSIONS_WEEK_FORMAT`;
 * - `resetsAt`: the week's reset, epoch ms;
 * - `at`: when it was read, epoch ms, to the minute;
 * - `sessions`: each session on the team's roster, by its id:
 *   - `usedPct`: its use since the week began, in percent of the account's week, the unit the status line counts in:
 *     its W at the team's own W per percent;
 *   - `workHours`: the UTC hours since the week began in which it used any W, the week's first hour counted whole.
 *
 * Percents are rounded to two decimals. A hook of any of the team's sessions rewrites it when that changes it.
 */
export const SESSIONS_WEEK_IN_STATE = ['usage', 'sessions.week.json'] as const;

/** The sessions' week file's format; a field added to it raises this. */
export const SESSIONS_WEEK_FORMAT = 1;

/** One session's week as the file holds it. */
export interface SessionWeek {
  readonly usedPct: number;
  readonly workHours: number;
}

/** The team's sessions' week as the file holds it. */
export interface SessionsWeekSummary {
  readonly resetsAt: number;
  readonly at: number;
  /** By session id, in the roster's order. */
  readonly sessions: Readonly<Record<string, SessionWeek>>;
}

/** The summary as its file's text. */
export function formatSessionsWeek(summary: SessionsWeekSummary): string {
  const { resetsAt, at, sessions } = summary;
  return JSON.stringify({ [VERSION_FIELD]: SESSIONS_WEEK_FORMAT, resetsAt, at, sessions });
}

function sessionWeekOf(value: unknown): SessionWeek | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usedPct = numberField(value, 'usedPct');
  const workHours = value['workHours'];
  return usedPct === undefined || !isNonNegativeInteger(workHours) ? undefined : { usedPct, workHours };
}

/** The file's text; undefined when it is damaged, a session's entry included, or in a format this teamrig cannot read. */
export function parseSessionsWeek(text: string): SessionsWeekSummary | undefined {
  const parsed = parseObject(text);
  if (parsed === undefined || recordVersion(parsed) !== SESSIONS_WEEK_FORMAT) {
    return undefined;
  }
  const resetsAt = numberField(parsed, 'resetsAt');
  const at = numberField(parsed, 'at');
  const stored = recordField(parsed, 'sessions');
  if (resetsAt === undefined || at === undefined || stored === undefined) {
    return undefined;
  }
  const sessions: [string, SessionWeek][] = [];
  for (const [id, value] of Object.entries(stored)) {
    const week = sessionWeekOf(value);
    if (week === undefined) {
      return undefined;
    }
    sessions.push([id, week]);
  }
  return { resetsAt, at, sessions: Object.fromEntries(sessions) };
}
