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

/** The Claude account a team's week is on: its `budget.account`, else the Claude config dir, which signs in one account. */
export function accountOf(budget: Pick<BudgetConfig, 'account'>, configDir: string): string {
  return budget.account ?? configDir;
}

/**
 * The team that keeps the week's files of a team's account (its period, meter log and extra-usage log, budget/team-week.ts):
 * the highest team above it reached through teams all on `account`, else the team itself. A child team on its parent's
 * account so reads and writes its parent's files, and learns the account's W per percent from them; a team on another
 * account than its parent, a root, a team whose parents go round a loop and a separate tree on the same account each keep
 * their own. `accountOfTeam` gives each loaded team's account (`accountOf`), undefined for a team with no config.
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

/** The team that asks, its account, and the week's reading the lifts in force are taken at. */
export interface AccountScope {
  readonly team: string;
  /** Its account (`accountOf`). */
  readonly account: string;
  /** The Claude config dir: the account of a team that sets none. */
  readonly configDir: string;
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
    if (team === scope.team || accountOf(config.budget, scope.configDir) !== scope.account) {
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

/** A team of the kit home as `accountWeekOf` reads it: where its status line snapshots are, and its account. */
export interface SnapshotDirSource {
  readonly kit: { readonly paths: Pick<TeamPaths, 'home' | 'kitHome'> };
  readonly config: { readonly budget: Pick<BudgetConfig, 'account' | 'statusSnapshotDir'> };
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
  scope: Pick<AccountScope, 'account' | 'configDir' | 'now'>,
): Promise<WeekFold> {
  let fold = await readFolderWeek(files, own, scope.now);
  const read = new Set([own]);
  for (const { kit, config } of teams.values()) {
    const dir = snapshotDirOf(config.budget, kit.paths);
    if (!read.has(dir) && accountOf(config.budget, scope.configDir) === scope.account) {
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
