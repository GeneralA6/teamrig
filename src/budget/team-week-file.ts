import type { Files } from '../core/files.ts';
import type { LimitSpan } from '../register/stats.ts';
import type { WeekWindow } from './pace.ts';
import { teamShareOf, type TeamsOnAccount } from './parts.ts';
import type { UsageState } from './store.ts';
import { keepSummaryFile, summaryMinute, summaryPct } from './summary-file.ts';
import { formatTeamWeek, TEAM_WEEK_FORMAT, type NamedTeamWeek } from './team-week-summary.ts';
import { wSince } from './week.ts';

/** What the team's week summary is read from: the week as the budget hooks read it, and the team's own stores. */
export interface TeamWeekInput {
  /** The team's Claude account (src/budget/account.ts `accountsOf`), which the summary names. */
  readonly account: string;
  readonly window: WeekWindow | undefined;
  /** The account's use of the week, in percent. */
  readonly usedPct: number | undefined;
  /** The team's own W per percent of the week. */
  readonly wPerPct: number | undefined;
  readonly targetPct: number;
  /** The team's sessions' usage stores only, never the outside one. */
  readonly states: readonly UsageState[];
  /** The team and the other teams on its account, which split what the account has left (`teamShareOf`). */
  readonly teams: TeamsOnAccount;
  /** The stretches the account's week sat at its usage limit (budget/team-week.ts `TeamWeekReading`). */
  readonly limits: readonly LimitSpan[];
  readonly now: number;
}

/**
 * The team's week summary (src/budget/team-week-summary.ts): its sessions' W since the week began at its own rate,
 * and that plus its part of what the account has left to the target (the split as is, as a surplus reads it: no day's
 * funding), on the team's account; undefined while the week, its use or the rate is unknown.
 */
export function teamWeekSummaryOf(input: TeamWeekInput): NamedTeamWeek | undefined {
  const { window, usedPct, wPerPct, now } = input;
  if (window === undefined || usedPct === undefined || wPerPct === undefined || wPerPct <= 0) {
    return undefined;
  }
  const teamUsedPct = wSince(input.states, window.start, now) / wPerPct;
  const leftPct = teamShareOf(Math.max(0, input.targetPct - usedPct), input.teams.split, input.teams.others);
  return {
    account: input.account,
    usedPct: summaryPct(teamUsedPct),
    plannedPct: summaryPct(teamUsedPct + leftPct),
    accountUsedPct: summaryPct(usedPct),
    resetsAt: window.reset,
    at: summaryMinute(now),
    limits: input.limits,
  };
}

/** Writes the team's week summary at `path` when that changes it, as every week summary is kept (`keepSummaryFile`); returns whether it wrote. */
export async function keepTeamWeek(files: Pick<Files, 'read' | 'write'>, path: string, summary: NamedTeamWeek): Promise<boolean> {
  return keepSummaryFile(files, path, formatTeamWeek(summary), TEAM_WEEK_FORMAT);
}
