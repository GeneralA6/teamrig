import { accountHolderOf, accountOf, accountTeamsOf, accountWeekOf, type AccountScope } from '../budget/account.ts';
import { LiftLog } from '../budget/lift.ts';
import { budgetSplitOf, type BudgetSplit, type TeamsOnAccount } from '../budget/parts.ts';
import { snapshotDirOf, weekUseAt, type WeekUse } from '../budget/snapshot.ts';
import type { TeamWeekPaths } from '../budget/team-week.ts';
import type { WorkByPriority } from '../budget/work.ts';
import type { BudgetConfig, KitConfig } from '../config/types.ts';
import { claudeConfigDir, type TeamPaths } from '../core/home.ts';
import type { CliRuntime } from './runtime.ts';
import { loadTree, type KitTree } from './tree.ts';

/** The team that asks: its id, its config's budget and lead tree, and its usage folder, which keeps the other teams' work caches. */
export interface AskingTeam {
  readonly team: string;
  readonly config: Pick<KitConfig, 'budget' | 'leads'>;
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
  /** Each session's queued work by priority (src/budget/work.ts `workWeights` or `cachedWork`). */
  readonly work: ReadonlyMap<string, WorkByPriority>;
}

/**
 * The team that asks, split by its roster, `budget.sessions`, lifts in force at `now` and queued work, beside the
 * other teams on its account (`otherTeamsOnAccount`): what the account's day and spare are split among.
 */
export async function teamsOnAccountOf(runtime: CliRuntime, asking: AskingRoster, now: number, usedPct: number | undefined): Promise<TeamsOnAccount> {
  const { lifts } = await new LiftLog(runtime.files, asking.liftsPath).read();
  const split = budgetSplitOf({ team: asking.team, ids: asking.ids, sessions: asking.config.budget.sessions, leads: asking.config.leads, work: asking.work, lifts, now, usedPct });
  return { split, others: await otherTeamsOnAccount(runtime, asking, now, usedPct) };
}

/**
 * The week's use at `now` from the newest status line reading on the asking team's Claude account (`accountWeekOf`):
 * its own folder's, then the other teams' on the account, read-only, each through its week summary when it keeps one,
 * so a team whose tabs are idle reads the account's newest week %. Every team's config is read on each call.
 */
export async function weekUseOnAccount(
  runtime: CliRuntime,
  budget: Pick<BudgetConfig, 'account' | 'statusSnapshotDir'>,
  paths: Pick<TeamPaths, 'home' | 'kitHome'>,
  now: number,
): Promise<WeekUse | undefined> {
  const { teams } = await loadTree(runtime);
  const configDir = claudeConfigDir(runtime.env, runtime.userHome);
  return statusUseOf(runtime, teams, budget, paths, { account: accountOf(budget, configDir), configDir, now });
}

/** The week on the asking team's account as its readers take it: the status line's use and the files it is read in. */
export interface AccountWeek {
  /** The newest status line reading's use at `now` (`weekUseOnAccount`); undefined with none this week. */
  readonly statusUse: WeekUse | undefined;
  /**
   * The week's files of the account (`accountHolderOf`): its period, meter log and extra-usage log, kept in the folder
   * of the highest team above the asking one on its account, else its own. A child team reads and writes them there,
   * so the account's W per percent is learned once for the tree; nothing else is written in another team's folder.
   */
  readonly paths: TeamWeekPaths;
}

/** `weekUseOnAccount` with the week's files of the account (`AccountWeek`), from one read of every team's config. */
export async function accountWeekOn(
  runtime: CliRuntime,
  budget: Pick<BudgetConfig, 'account' | 'statusSnapshotDir'>,
  paths: Pick<TeamPaths, 'team' | 'home' | 'kitHome'> & TeamWeekPaths,
  now: number,
): Promise<AccountWeek> {
  const { tree, teams } = await loadTree(runtime);
  const configDir = claudeConfigDir(runtime.env, runtime.userHome);
  const account = accountOf(budget, configDir);
  const statusUse = await statusUseOf(runtime, teams, budget, paths, { account, configDir, now });
  const holder = accountHolderOf(tree, paths.team, account, (team) => {
    const loaded = teams.get(team);
    return loaded === undefined ? undefined : accountOf(loaded.config.budget, configDir);
  });
  return { statusUse, paths: teams.get(holder)?.kit.paths ?? paths };
}

async function statusUseOf(
  runtime: CliRuntime,
  teams: KitTree['teams'],
  budget: Pick<BudgetConfig, 'statusSnapshotDir'>,
  paths: Pick<TeamPaths, 'home' | 'kitHome'>,
  scope: Pick<AccountScope, 'account' | 'configDir' | 'now'>,
): Promise<WeekUse | undefined> {
  const fold = await accountWeekOf(runtime.files, teams, snapshotDirOf(budget, paths), scope);
  return weekUseAt(fold, scope.now);
}
