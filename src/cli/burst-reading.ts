import type { BurstRecord } from '../budget/burst.ts';
import { BurstLog } from '../budget/burst-log.ts';
import { resolveReset, weekWindow, type WeekWindow } from '../budget/pace.ts';
import { readSnapshots, weekUseOf } from '../budget/snapshot.ts';
import type { BudgetConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { snapshotDirOf } from './commands/budget.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The bursts as `check`, `hire --burst` and `burst end` read them: the burst log, the week's use from the newest
 * status-line reading and the week it counts in (whose spare pays `check`'s SCALE-OUT), one log and one folder read,
 * no transcript measured. With no status-line reading the use is unknown, so a burst then ends by its time or the
 * lead's end only, never by its stop %, and no SCALE-OUT is raised.
 */

export interface BurstReading {
  readonly records: readonly BurstRecord[];
  /** The week's use from the newest status-line reading, in %; undefined with none this week. */
  readonly usedPct: number | undefined;
  /** The week that reading counts in: up to its reset, else the config's; undefined with neither. */
  readonly window: WeekWindow | undefined;
}

export async function readBursts(runtime: CliRuntime, paths: Pick<TeamPaths, 'bursts' | 'home' | 'kitHome'>, budget: BudgetConfig, now: number): Promise<BurstReading> {
  const { records } = await new BurstLog(runtime.files, paths.bursts).read();
  const use = weekUseOf(await readSnapshots(runtime.files, snapshotDirOf(budget, paths)), now);
  const reset = resolveReset(now, use?.resetsAt, budget.reset);
  return { records, usedPct: use?.usedPct, window: reset === undefined ? undefined : weekWindow(reset, budget.paceEndHoursBeforeReset) };
}
