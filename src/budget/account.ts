import { join } from 'node:path';
import type { TeamTree } from '../config/tree.ts';
import type { BudgetConfig, KitConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import { LiftLog, type Lift } from './lift.ts';
import { budgetSplitOf, type BudgetSplit } from './parts.ts';
import { pausableOf } from './pause.ts';
import { mergeWeekFolds, snapshotDirOf, type WeekFold } from './snapshot.ts';
import { readFolderWeek } from './week-summary.ts';
import { cachedWork } from './work.ts';

/** What tells a team's Claude account: the `budget.account` it names (its own or the team above's), and its config dir. */
export interface TeamAccountFacts {
  readonly account: string | undefined;
  /** The Claude config dir its sessions start in (budget/config-dir.ts), undefined when none is recorded yet. */
  readonly configDir: string | undefined;
}

/** The asking team's Claude account, and each team's of the kit home, the asking one's too (`accountsOf`). */
export interface KitHomeAccounts {
  readonly account: string;
  readonly accounts: ReadonlyMap<string, string>;
}

/**
 * Each team's Claude account, which teams with the same one share the week of: the `budget.account` it names, else the
 * one the teams known to be on its config dir name, since one config dir signs in one account, else its config dir
 * itself. The asking team is on `configDir`, the one it runs in now, and a team with none recorded is taken to be on it
 * too, but lends it no name: where it runs is a guess. A config dir whose teams name two accounts gives a team that
 * names none its config dir: no name is the right one.
 */
export function accountsOf(asker: { readonly team: string; readonly account: string | undefined }, teams: ReadonlyMap<string, TeamAccountFacts>, configDir: string): KitHomeAccounts {
  const own: TeamAccountFacts = { account: asker.account, configDir };
  const all = new Map(teams).set(asker.team, own);
  const dirOf = (team: TeamAccountFacts): string => team.configDir ?? configDir;
  const named = new Map<string, Set<string>>();
  for (const { account, configDir: dir } of all.values()) {
    if (account !== undefined && dir !== undefined) {
      named.set(dir, (named.get(dir) ?? new Set<string>()).add(account));
    }
  }
  const accountOf = (team: TeamAccountFacts): string => {
    const names = [...(named.get(dirOf(team)) ?? [])];
    return team.account ?? (names.length === 1 ? names[0] : undefined) ?? dirOf(team);
  };
  return { account: accountOf(own), accounts: new Map([...all].map(([team, each]) => [team, accountOf(each)])) };
}

/**
 * The team that keeps the week's files of a team's account (its period, meter log and extra-usage log, budget/team-week.ts):
 * the highest team above it reached through teams all on `account`, else the team itself. A child team on its parent's
 * account so reads and writes its parent's files, logging its own W in their meter log (T1669); a team on another
 * account than its parent, a root, a team whose parents go round a loop and a separate tree on the same account each keep
 * their own. `accountOfTeam` gives each loaded team's account (`accountsOf`), undefined for a team with no config.
 */
export function accountHolderOf(tree: Pick<TeamTree, 'ancestorsOf'>, team: string, account: string, accountOfTeam: (team: string) => string | undefined): string {
  let holder = team;
  for (const above of tree.ancestorsOf(team).reverse()) {
    if (accountOfTeam(above) !== account) {
      break;
    }
    holder = above;
  }
  return holder;
}

/** A team of the kit home as `accountTeamsOf` reads it; `loadTree` gives one for each team. */
export interface AccountTeamSource {
  readonly kit: { readonly paths: Pick<TeamPaths, 'events' | 'lifts'> };
  readonly config: KitConfig;
  readonly roster: { readonly ids: readonly string[] };
}

/**
 * The team that asks, its account and each team's (`accountsOf`: a team is on the asking one's when it has the same),
 * and the week's reading the lifts in force are taken at.
 */
export interface AccountScope extends KitHomeAccounts {
  readonly team: string;
  /** Its usage folder, which keeps the other teams' work caches, so reading them writes nothing in their folders. */
  readonly usageDir: string;
  readonly now: number;
  readonly usedPct: number | undefined;
}

/** The file in the asking team's usage folder that caches another team's queued work. */
export function workCacheFileOf(team: string): string {
  return `work.cache.${team}.json`;
}

/**
 * The other teams of the kit home on the asking team's account, in the order of `teams`, each split by its roster,
 * `budget.sessions`, lifts in force, queued work and the sessions its own `budget.pauseByPriority` may pause (`pausableOf`),
 * read-only. A register that cannot be read counts each of its
 * sessions at weight 1 (`cachedWork`) and a lift log that cannot be read holds no lift, so another team's folder
 * never stops this team's budget.
 */
export async function accountTeamsOf(files: Files, teams: ReadonlyMap<string, AccountTeamSource>, scope: AccountScope): Promise<BudgetSplit[]> {
  const others: BudgetSplit[] = [];
  for (const [team, { kit, config, roster }] of teams) {
    if (team === scope.team || scope.accounts.get(team) !== scope.account) {
      continue;
    }
    const lifts = await liftsOf(files, kit.paths.lifts);
    const { weights: work } = await cachedWork(files, kit.paths.events, join(scope.usageDir, workCacheFileOf(team)), config.register.priorities);
    others.push(budgetSplitOf({ team, ids: roster.ids, sessions: config.budget.sessions, leads: config.leads, work, pausable: pausableOf(config, team, roster.ids), lifts, now: scope.now, usedPct: scope.usedPct }));
  }
  return others;
}

async function liftsOf(files: Files, path: string): Promise<readonly Lift[]> {
  try {
    return (await new LiftLog(files, path).read()).lifts;
  } catch {
    return [];
  }
}

/** A team of the kit home as `accountWeekOf` reads it: where its status line snapshots are. */
export interface SnapshotDirSource {
  readonly kit: { readonly paths: Pick<TeamPaths, 'home' | 'kitHome'> };
  readonly config: { readonly budget: Pick<BudgetConfig, 'statusSnapshotDir'> };
}

/** A fold of no reading, for a folder that cannot be read. */
const NO_READING: WeekFold = { best: undefined, followedBy: undefined };

/**
 * The status line readings of the week on the asking team's account, folded, read-only: its own folder's (`own`),
 * then each other team's on the account in the order of `teams`, each folder once, through its week summary when it
 * keeps one (`readFolderWeek`). A team's tabs write only its own folder, so a team whose tabs are idle would show an
 * old week %; the merged fold takes the newest reading among them all. Another team's folder that cannot be read
 * gives no reading, so it never stops this team's budget.
 */
export async function accountWeekOf(
  files: Pick<Files, 'list' | 'read'>,
  teams: ReadonlyMap<string, SnapshotDirSource>,
  own: string,
  scope: Pick<AccountScope, 'account' | 'accounts' | 'now'>,
): Promise<WeekFold> {
  let fold = await readFolderWeek(files, own, scope.now);
  const read = new Set([own]);
  for (const [team, { kit, config }] of teams) {
    const dir = snapshotDirOf(config.budget, kit.paths);
    if (!read.has(dir) && scope.accounts.get(team) === scope.account) {
      read.add(dir);
      fold = mergeWeekFolds(fold, await othersWeek(files, dir, scope.now));
    }
  }
  return fold;
}

async function othersWeek(files: Pick<Files, 'list' | 'read'>, dir: string, now: number): Promise<WeekFold> {
  try {
    return await readFolderWeek(files, dir, now);
  } catch {
    return NO_READING;
  }
}
