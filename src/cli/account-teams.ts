import { accountHolderOf, accountsOf, accountTeamsOf, accountWeekOf, type AccountScope, type KitHomeAccounts, type TeamAccountFacts } from '../budget/account.ts';
import type { PeerTeam } from '../budget/attribute.ts';
import { readConfigDir } from '../budget/config-dir.ts';
import { LiftLog } from '../budget/lift.ts';
import { budgetSplitOf, type BudgetSplit, type TeamsOnAccount } from '../budget/parts.ts';
import { pausableOf } from '../budget/pause.ts';
import { snapshotDirOf, weekUseAt, type WeekUse } from '../budget/snapshot.ts';
import type { TeamWeekPaths } from '../budget/team-week.ts';
import type { WorkByPriority } from '../budget/work.ts';
import type { BudgetConfig, KitConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { claudeConfigDir, type TeamPaths } from '../core/home.ts';
import { PlainLogFile } from '../core/log-file.ts';
import { indexMarks } from '../inbox/marks.ts';
import { JsonlMarkLog } from '../inbox/store.ts';
import type { CliRuntime } from './runtime.ts';
import { loadTree, type KitTree } from './tree.ts';

/** The team that asks: its id, its config's budget and lead tree, and its usage folder, which keeps the other teams' work caches. */
export interface AskingTeam {
  readonly team: string;
  readonly config: Pick<KitConfig, 'budget' | 'leads'>;
  readonly usageDir: string;
}

/** The team that asks which Claude account each team of the kit home is on: its id and its `budget.account`. */
export interface AccountAsker {
  readonly team: string;
  readonly budget: Pick<BudgetConfig, 'account'>;
}

/**
 * The asking team's Claude account and each team's of the kit home (`accountsOf`), read-only: each team's from its config
 * and the config dir its sessions last started in (budget/config-dir.ts), the asking team's from the one this process
 * runs in, so two logins with no `budget.account` read as two accounts, and teams on one login as one.
 */
export async function kitHomeAccountsOf(runtime: CliRuntime, teams: KitTree['teams'], asker: AccountAsker): Promise<KitHomeAccounts> {
  const facts = new Map<string, TeamAccountFacts>();
  for (const [team, { kit, config }] of teams) {
    facts.set(team, { account: config.budget.account, configDir: await readConfigDir(runtime.files, kit.paths.configDirRecord) });
  }
  return accountsOf({ team: asker.team, account: asker.budget.account }, facts, claudeConfigDir(runtime.env, runtime.userHome));
}

/**
 * The other teams of the kit home on the asking team's Claude account (`accountTeamsOf`), each split by its roster,
 * shares, lifts in force at `now` and queued work, read-only. Every team's config is read on each call.
 */
export async function otherTeamsOnAccount(runtime: CliRuntime, asking: AskingTeam, now: number, usedPct: number | undefined): Promise<BudgetSplit[]> {
  const { teams } = await loadTree(runtime);
  const accounts = await kitHomeAccountsOf(runtime, teams, { team: asking.team, budget: asking.config.budget });
  return accountTeamsOf(runtime.files, teams, { team: asking.team, ...accounts, usageDir: asking.usageDir, now, usedPct });
}

/** The team that asks with what splits it: its roster, its roles, its lift log and each session's queued work. */
export interface AskingRoster extends AskingTeam {
  /** Its config's budget, lead tree and roles, whose holders a short day never pauses (src/budget/pause.ts `pausableOf`). */
  readonly config: Pick<KitConfig, 'budget' | 'leads' | 'roles'>;
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
  const split = budgetSplitOf({ team: asking.team, ids: asking.ids, sessions: asking.config.budget.sessions, leads: asking.config.leads, work: asking.work, pausable: pausableOf(asking.config, asking.team, asking.ids), lifts, now, usedPct });
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
  paths: Pick<TeamPaths, 'team' | 'home' | 'kitHome'>,
  now: number,
): Promise<WeekUse | undefined> {
  const { teams } = await loadTree(runtime);
  const accounts = await kitHomeAccountsOf(runtime, teams, { team: paths.team, budget });
  return statusUseOf(runtime, teams, budget, paths, { ...accounts, now });
}

/** Another team keeping its week in the account's files: its id, its usage folder, its roster's session ids and its inbox marks file. */
export interface AccountPeer {
  readonly team: string;
  readonly usage: string;
  readonly ids: readonly string[];
  readonly inboxMarks: string;
}

/** The week on the asking team's account as its readers take it: the status line's use and the files it is read in. */
export interface AccountWeek {
  /** The asking team's Claude account (`kitHomeAccountsOf`). */
  readonly account: string;
  /** The newest status line reading's use at `now` (`weekUseOnAccount`); undefined with none this week. */
  readonly statusUse: WeekUse | undefined;
  /**
   * The week's files of the account (`accountHolderOf`): its period, meter log and extra-usage log, kept in the folder
   * of the highest team above the asking one on its account, else its own. A child team reads and writes them there,
   * so the tree reads one period and one extra-usage pool, each team's W per percent learned from its own lines of the
   * one meter log; nothing else is written in another team's folder.
   */
  readonly paths: TeamWeekPaths;
  /** The team whose folder keeps those files (`accountHolderOf`): the asking team itself, or one above it. */
  readonly keeper: string;
  /**
   * The other teams on the account keeping their week in those files (the keeper's, when it is not the asking team)
   * with the budget on, as their config reads with what it inherits: a crossing is logged for each on its own W scale
   * (budget/team-week.ts `teamWeekOf`, T1669), and the tabs they mark are left to their hooks. A team with the budget
   * off is none: its hooks meter nothing, so its use stays outside.
   */
  readonly peers: readonly AccountPeer[];
}

/** `weekUseOnAccount` with the week's files of the account (`AccountWeek`), from one read of every team's config. */
export async function accountWeekOn(
  runtime: CliRuntime,
  budget: Pick<BudgetConfig, 'account' | 'statusSnapshotDir'>,
  paths: Pick<TeamPaths, 'team' | 'home' | 'kitHome'> & TeamWeekPaths,
  now: number,
): Promise<AccountWeek> {
  const { tree, teams } = await loadTree(runtime);
  const accounts = await kitHomeAccountsOf(runtime, teams, { team: paths.team, budget });
  const { account } = accounts;
  const statusUse = await statusUseOf(runtime, teams, budget, paths, { ...accounts, now });
  const accountOfTeam = (team: string): string | undefined => accounts.accounts.get(team);
  const holder = accountHolderOf(tree, paths.team, account, accountOfTeam);
  const keepsHere = (team: string): boolean => team !== paths.team && accountOfTeam(team) === account && accountHolderOf(tree, team, account, accountOfTeam) === holder;
  const peers = [...teams]
    .filter(([team, loaded]) => keepsHere(team) && loaded.config.budget.enabled)
    .map(([team, loaded]) => ({ team, usage: loaded.kit.paths.usage, ids: loaded.roster.ids, inboxMarks: loaded.kit.paths.inboxMarks }));
  return { account, statusUse, paths: teams.get(holder)?.kit.paths ?? paths, keeper: holder, peers };
}

/** Each peer's session ids with the session of it each Claude Code session last read its inbox as, read-only. */
export async function peerMarksOf(files: Files, peers: readonly AccountPeer[]): Promise<PeerTeam[]> {
  return Promise.all(
    peers.map(async (peer) => {
      const { marks } = await new JsonlMarkLog(new PlainLogFile(files, peer.inboxMarks)).read();
      return { ids: peer.ids, areaBySession: indexMarks(marks).areaBySession };
    }),
  );
}

async function statusUseOf(
  runtime: CliRuntime,
  teams: KitTree['teams'],
  budget: Pick<BudgetConfig, 'statusSnapshotDir'>,
  paths: Pick<TeamPaths, 'home' | 'kitHome'>,
  scope: Pick<AccountScope, 'account' | 'accounts' | 'now'>,
): Promise<WeekUse | undefined> {
  const fold = await accountWeekOf(runtime.files, teams, snapshotDirOf(budget, paths), scope);
  return weekUseAt(fold, scope.now);
}
