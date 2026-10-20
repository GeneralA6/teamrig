import { join } from 'node:path';
import { OUTSIDE_ID } from '../budget/measure.ts';
import { PeriodStore } from '../budget/period.ts';
import { readSnapshots, weekUseOf } from '../budget/snapshot.ts';
import { UsageStore, type UsageState } from '../budget/store.ts';
import { meteredOf, readWeek, type WeekReading } from '../budget/week.ts';
import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { snapshotDirOf } from './commands/budget.ts';
import type { CliRuntime } from './runtime.ts';

/** The team paths a stored reading of the week reads. */
export type StoredWeekPaths = Pick<TeamPaths, 'usage' | 'period' | 'home' | 'kitHome'>;

/**
 * The week as a hook reads it: each session's use as last stored, the use outside the team and the newest
 * status-line reading, no transcript measured.
 */
export async function readStoredWeek(
  runtime: CliRuntime,
  paths: StoredWeekPaths,
  config: Pick<KitConfig, 'sessions' | 'budget'>,
  now: number,
): Promise<WeekReading> {
  const { files } = runtime;
  const { budget, sessions } = config;
  const team = new UsageStore(files, paths.usage);
  const states: UsageState[] = [];
  for (const id of sessions) {
    states.push((await team.load(id)).state);
  }
  states.push((await new UsageStore(files, join(paths.usage, 'outside')).load(OUTSIDE_ID)).state);
  const statusUse = weekUseOf(await readSnapshots(files, snapshotDirOf(budget, paths)), now);
  const period = await new PeriodStore(files, paths.period).periodAt(budget, statusUse, now, meteredOf(budget, states, now));
  return readWeek({ budget, now, statusUse, period, states });
}

