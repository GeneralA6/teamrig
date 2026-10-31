import { numberField } from '../core/guards.ts';
import { parseObject, recordVersion, VERSION_FIELD } from '../core/jsonl.ts';

/**
 * The team's week summary: its used and planned part of the account's week, kept by the budget hooks
 * (src/budget/team-week-file.ts) for a reader that shows each team's week without recomputing the budget, as the
 * pane's Teams tab does. One file per team, in its own folder: a child team keeps its own, and a reader that shows a
 * parent with its children adds theirs to it. It sits at `TEAM_WEEK_PATH` under the team's home
 * (`<kit home>/teams/<team>`); the format, one JSON object:
 *
 * - `v`: `TEAM_WEEK_FORMAT`;
 * - `usedPct`: the team's use since the week began, in percent of the account's week: its sessions' W at the team's
 *   own W per percent (the use outside every team is no team's);
 * - `plannedPct`: the team's use by the week's end as planned: `usedPct` plus its part (src/budget/parts.ts
 *   `teamShareOf`) of what the account has left to `budget.targetPct`;
 * - `accountUsedPct`: the account's use of the week, in percent: every team's and the use outside them;
 * - `resetsAt`: the week's reset, epoch ms;
 * - `at`: when it was read, epoch ms, to the minute.
 *
 * Percents are rounded to two decimals. A hook of any of the team's sessions rewrites it when that changes it.
 */
export const TEAM_WEEK_PATH = ['state', 'usage', 'team.week.json'] as const;

/** The team week summary's format; a field added to it raises this. */
export const TEAM_WEEK_FORMAT = 1;

/** The team's week as its summary file holds it. */
export interface TeamWeekSummary {
  readonly usedPct: number;
  readonly plannedPct: number;
  readonly accountUsedPct: number;
  readonly resetsAt: number;
  readonly at: number;
}

/** The summary as its file's text. */
export function formatTeamWeek(summary: TeamWeekSummary): string {
  const { usedPct, plannedPct, accountUsedPct, resetsAt, at } = summary;
  return JSON.stringify({ [VERSION_FIELD]: TEAM_WEEK_FORMAT, usedPct, plannedPct, accountUsedPct, resetsAt, at });
}

/** The summary file's text; undefined when it is damaged or in a format this teamrig cannot read. */
export function parseTeamWeek(text: string): TeamWeekSummary | undefined {
  const parsed = parseObject(text);
  if (parsed === undefined || recordVersion(parsed) !== TEAM_WEEK_FORMAT) {
    return undefined;
  }
  const usedPct = numberField(parsed, 'usedPct');
  const plannedPct = numberField(parsed, 'plannedPct');
  const accountUsedPct = numberField(parsed, 'accountUsedPct');
  const resetsAt = numberField(parsed, 'resetsAt');
  const at = numberField(parsed, 'at');
  return usedPct === undefined || plannedPct === undefined || accountUsedPct === undefined || resetsAt === undefined || at === undefined
    ? undefined
    : { usedPct, plannedPct, accountUsedPct, resetsAt, at };
}
