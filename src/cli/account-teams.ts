import { accountOf, accountTeamsOf } from '../budget/account.ts';
import type { BudgetSplit } from '../budget/parts.ts';
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
