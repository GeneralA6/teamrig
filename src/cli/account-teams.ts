import { accountOf, accountTeamsOf } from '../budget/account.ts';
import { LiftLog } from '../budget/lift.ts';
import { liftedParts, type BudgetSplit, type TeamsOnAccount } from '../budget/parts.ts';
import type { KitConfig } from '../config/types.ts';
import { claudeConfigDir } from '../core/home.ts';
import type { CliRuntime } from './runtime.ts';
import { loadTree } from './tree.ts';

/** The team that asks: its id, its config's budget and its usage folder, which keeps the other teams' work caches. */
export interface AskingTeam {
  readonly team: string;
  readonly config: Pick<KitConfig, 'budget'>;
  readonly usageDir: string;
}

/**
 * The other teams of the kit home on the asking team's Claude account (`accountTeamsOf`), each split by its roster,
 * shares, lifts in force at `now` and queued work, read-only. Every team's config is read on each call.
 */
export async function otherTeamsOnAccount(runtime: CliRuntime, asking: AskingTeam, now: number, usedPct: number | undefined): Promise<BudgetSplit[]> {
  const { teams } = await loadTree(runtime);
  const configDir = claudeConfigDir(runtime.env, runtime.userHome);
  return accountTeamsOf(runtime.files, teams, {
    team: asking.team,
    account: accountOf(asking.config.budget, configDir),
    configDir,
    usageDir: asking.usageDir,
    now,
    usedPct,
  });
}

/** The team that asks with what splits it: its roster, its lift log and each session's queued work. */
export interface AskingRoster extends AskingTeam {
  readonly ids: readonly string[];
  readonly liftsPath: string;
  /** Each session's queued work (src/budget/work.ts `workWeights` or `cachedWork`). */
  readonly work: ReadonlyMap<string, number>;
}

/**
 * The team that asks, split by its roster, `budget.sessions`, lifts in force at `now` and queued work, beside the
 * other teams on its account (`otherTeamsOnAccount`): what the account's day and spare are split among.
 */
export async function teamsOnAccountOf(runtime: CliRuntime, asking: AskingRoster, now: number, usedPct: number | undefined): Promise<TeamsOnAccount> {
  const { lifts } = await new LiftLog(runtime.files, asking.liftsPath).read();
  const split: BudgetSplit = { team: asking.team, ids: asking.ids, sessions: asking.config.budget.sessions, work: asking.work, lifted: liftedParts(lifts, asking.ids, now, usedPct) };
  return { split, others: await otherTeamsOnAccount(runtime, asking, now, usedPct) };
}
