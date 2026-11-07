import { isRecord, numberField, stringField } from '../core/guards.ts';
import { parseObject, recordVersion, VERSION_FIELD } from '../core/jsonl.ts';
import type { LimitSpan } from '../register/stats.ts';

/**
 * The team's week summary: its used and planned part of the account's week, kept by the budget hooks
 * (src/budget/team-week-file.ts) for a reader that shows each team's week without recomputing the budget, as the
 * pane's Teams tab does. One file per team, in its own folder: a child team keeps its own, and a reader that shows a
 * parent with its children adds theirs to it. It sits at `TEAM_WEEK_IN_STATE` under the team's state folder
 * (`<kit home>/teams/<team>/state`, unless the team config's `paths.state` moves it); the format, one JSON object:
 *
 * - `v`: `TEAM_WEEK_FORMAT`;
 * - `account`: the Claude account whose week the percents are of, as teamrig tells accounts apart (src/budget/account.ts
 *   `accountsOf`): the `budget.account` the team names, else the config dir its sessions run in. A reader adds up only
 *   files that name one account: teams on two accounts each have a week of their own;
 * - `usedPct`: the team's use since the week began, in percent of the account's week: its sessions' W at the team's
 *   own W per percent (the use outside every team is no team's);
 * - `plannedPct`: the team's use by the week's end as planned: `usedPct` plus its part (src/budget/parts.ts
 *   `teamShareOf`) of what the account has left to `budget.targetPct`;
 * - `accountUsedPct`: the account's use of the week, in percent: every team's and the use outside them;
 * - `resetsAt`: the week's reset, epoch ms;
 * - `start`: where the week's use counts from, epoch ms: the reset before it, or one inside the week (src/budget/pace.ts
 *   `WeekWindow`), for a reader that draws the pace line `teamrig budget` reads but cannot open the account's period on
 *   every tick, as the status line;
 * - `at`: when it was read, epoch ms, to the minute;
 * - `limits`: the stretches the account's week sat at its usage limit, oldest first, each `{ start, end }` in epoch ms
 *   (src/budget/extra.ts `limitSpansOf`), for a reader that marks those days but cannot load the meter log, as the
 *   pane's Stats tab. Every team on the account writes the same list, at most one stretch a period the log still keeps.
 *
 * Percents are rounded to two decimals. A hook of any of the team's sessions rewrites it when that changes it. Format 2
 * had every field but `start`, and format 1 none of `start`, `account` and `limits`; both are still read, naming what
 * they lack as nothing, since a team whose sessions are idle keeps its file until a hook of it runs again.
 */
export const TEAM_WEEK_IN_STATE = ['usage', 'team.week.json'] as const;

/** The team week summary's format; a field added to it raises this. */
export const TEAM_WEEK_FORMAT = 3;

/** The format before `start`, still read for a team whose hooks have not written since. */
const UNSTARTED_FORMAT = 2;

/** The format before `account` and `limits`, still read for a team whose hooks have not written since. */
const UNNAMED_FORMAT = 1;

/** The team's week as its summary file holds it. */
export interface TeamWeekSummary {
  /** The Claude account the percents are of; undefined from a format 1 file, which named none. */
  readonly account: string | undefined;
  readonly usedPct: number;
  readonly plannedPct: number;
  readonly accountUsedPct: number;
  readonly resetsAt: number;
  /** Where the week's use counts from; undefined from a format 1 or 2 file, which held none. */
  readonly start: number | undefined;
  readonly at: number;
  /** The stretches the account's week sat at its usage limit; none from a format 1 file, which held none. */
  readonly limits: readonly LimitSpan[];
}

/** The summary as a hook writes it: in the current format, so it always names the account and the week's start. */
export interface NamedTeamWeek extends TeamWeekSummary {
  readonly account: string;
  readonly start: number;
}

/** The summary as its file's text. */
export function formatTeamWeek(summary: NamedTeamWeek): string {
  const { account, usedPct, plannedPct, accountUsedPct, resetsAt, start, at, limits } = summary;
  return JSON.stringify({ [VERSION_FIELD]: TEAM_WEEK_FORMAT, account, usedPct, plannedPct, accountUsedPct, resetsAt, start, at, limits });
}

/** One stored stretch; undefined when it is damaged: a stretch ends after it starts. */
function parseLimitSpan(value: unknown): LimitSpan | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const start = numberField(value, 'start');
  const end = numberField(value, 'end');
  return start === undefined || end === undefined || start >= end ? undefined : { start, end };
}

/** The stored stretches; undefined when the list is missing or any of it is damaged. */
function parseLimits(value: unknown): readonly LimitSpan[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const spans = value.flatMap((entry: unknown) => {
    const span = parseLimitSpan(entry);
    return span === undefined ? [] : [span];
  });
  return spans.length === value.length ? spans : undefined;
}

/** The summary file's text; undefined when it is damaged or in a format this teamrig cannot read. */
export function parseTeamWeek(text: string): TeamWeekSummary | undefined {
  const parsed = parseObject(text);
  const version = parsed === undefined ? undefined : recordVersion(parsed);
  if (parsed === undefined || (version !== TEAM_WEEK_FORMAT && version !== UNSTARTED_FORMAT && version !== UNNAMED_FORMAT)) {
    return undefined;
  }
  const account = stringField(parsed, 'account');
  const usedPct = numberField(parsed, 'usedPct');
  const plannedPct = numberField(parsed, 'plannedPct');
  const accountUsedPct = numberField(parsed, 'accountUsedPct');
  const resetsAt = numberField(parsed, 'resetsAt');
  const at = numberField(parsed, 'at');
  if (usedPct === undefined || plannedPct === undefined || accountUsedPct === undefined || resetsAt === undefined || at === undefined) {
    return undefined;
  }
  if (version === UNNAMED_FORMAT) {
    return { account: undefined, usedPct, plannedPct, accountUsedPct, resetsAt, start: undefined, at, limits: [] };
  }
  const limits = parseLimits(parsed['limits']);
  const start = numberField(parsed, 'start');
  if (account === undefined || limits === undefined || (version === TEAM_WEEK_FORMAT && start === undefined)) {
    return undefined;
  }
  return { account, usedPct, plannedPct, accountUsedPct, resetsAt, start, at, limits };
}
