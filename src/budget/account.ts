import { join } from 'node:path';
import type { BudgetConfig, KitConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import { LiftLog, type Lift } from './lift.ts';
import { budgetSplitOf, type BudgetSplit } from './parts.ts';
import { readSnapshots, snapshotDirOf, type StatusSnapshot } from './snapshot.ts';
import { cachedWork } from './work.ts';

/** The Claude account a team's week is on: its `budget.account`, else the Claude config dir, which signs in one account. */
export function accountOf(budget: Pick<BudgetConfig, 'account'>, configDir: string): string {
  return budget.account ?? configDir;
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
  /** Its usage folder, which keeps the other teams' work caches: nothing is written in another team's folder. */
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
 * `budget.sessions`, lifts in force and queued work, read-only. A register that cannot be read counts each of its
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
    const work = await cachedWork(files, kit.paths.events, join(scope.usageDir, workCacheFileOf(team)), config.register.priorities);
    others.push(budgetSplitOf({ team, ids: roster.ids, sessions: config.budget.sessions, leads: config.leads, work, lifts, now: scope.now, usedPct: scope.usedPct }));
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

/** A team of the kit home as `accountSnapshotsOf` reads it: where its status line snapshots are, and its account. */
export interface SnapshotDirSource {
  readonly kit: { readonly paths: Pick<TeamPaths, 'home' | 'kitHome'> };
  readonly config: { readonly budget: Pick<BudgetConfig, 'account' | 'statusSnapshotDir'> };
}

/**
 * Every status line snapshot on the asking team's account, read-only: its own folder's (`own`), then each other
 * team's on the account in the order of `teams`, each folder once. A team's tabs write only its own folder, so a
 * team whose tabs are idle would show an old week %; `weekUseOf` takes the newest reading among them all. Another
 * team's folder that cannot be read gives no snapshot, so it never stops this team's budget.
 */
export async function accountSnapshotsOf(
  files: Pick<Files, 'list' | 'read'>,
  teams: ReadonlyMap<string, SnapshotDirSource>,
  own: string,
  scope: Pick<AccountScope, 'account' | 'configDir'>,
): Promise<StatusSnapshot[]> {
  const snapshots = await readSnapshots(files, own);
  const read = new Set([own]);
  for (const { kit, config } of teams.values()) {
    const dir = snapshotDirOf(config.budget, kit.paths);
    if (!read.has(dir) && accountOf(config.budget, scope.configDir) === scope.account) {
      read.add(dir);
      snapshots.push(...(await othersSnapshots(files, dir)));
    }
  }
  return snapshots;
}

async function othersSnapshots(files: Pick<Files, 'list' | 'read'>, dir: string): Promise<readonly StatusSnapshot[]> {
  try {
    return await readSnapshots(files, dir);
  } catch {
    return [];
  }
}
