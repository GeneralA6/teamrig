import type { BurstRecord } from '../budget/burst.ts';
import { BurstLog } from '../budget/burst-log.ts';
import { weekWindow, type WeekWindow } from '../budget/pace.ts';
import { PeriodStore } from '../budget/period.ts';
import type { TeamWeekPaths } from '../budget/team-week.ts';
import type { BudgetConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { accountWeekOn } from './account-teams.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The bursts as `check`, `hire --burst` and `burst end` read them: the burst log, the week's use from the newest
 * status-line reading on the account (`weekUseOnAccount`) and the week it counts in (whose spare pays `check`'s
 * SCALE-OUT), no transcript measured. With no status-line reading the use is unknown, so a burst then ends by its
 * time or the lead's end only, never by its stop %, and no SCALE-OUT is raised.
 */

export interface BurstReading {
  readonly records: readonly BurstRecord[];
  /** The week's use from the newest status-line reading, in %; undefined with none this week. */
  readonly usedPct: number | undefined;
  /** The period that reading counts in (budget/period.ts); undefined while no reset is known. */
  readonly window: WeekWindow | undefined;
}

export async function readBursts(
  runtime: CliRuntime,
  paths: Pick<TeamPaths, 'team' | 'bursts' | 'home' | 'kitHome'> & TeamWeekPaths,
  budget: BudgetConfig,
  now: number,
): Promise<BurstReading> {
  const { records } = await new BurstLog(runtime.files, paths.bursts).read();
  const account = await accountWeekOn(runtime, budget, paths, now);
  const use = account.statusUse;
  const period = await new PeriodStore(runtime.files, account.paths.period).periodAt(budget, use, now);
  return { records, usedPct: use?.usedPct, window: period === undefined ? undefined : weekWindow(period.end, budget.paceEndHoursBeforeReset, period.start) };
}
