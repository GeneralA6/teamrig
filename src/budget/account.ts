import { join } from 'node:path';
import type { BudgetConfig, KitConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import { LiftLog, type Lift } from './lift.ts';
import { liftedParts, type BudgetSplit } from './parts.ts';
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
    const lifted = liftedParts(lifts, roster.ids, scope.now, scope.usedPct);
    others.push({ team, ids: roster.ids, sessions: config.budget.sessions, work, lifted });
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
