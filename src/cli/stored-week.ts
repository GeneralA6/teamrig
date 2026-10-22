import { join } from 'node:path';
import { OUTSIDE_ID } from '../budget/measure.ts';
import { readSnapshots, weekUseOf } from '../budget/snapshot.ts';
import { UsageStore, type UsageState } from '../budget/store.ts';
import { calibrationOf, MeterLog } from '../budget/calibration.ts';
import { teamWeekOf } from '../budget/team-week.ts';
import { rateOf, type WeekReading } from '../budget/week.ts';
import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { snapshotDirOf } from './commands/budget.ts';
import type { CliRuntime } from './runtime.ts';

/** The team paths a stored reading of the week reads. */
export type StoredWeekPaths = Pick<TeamPaths, 'usage' | 'period' | 'meterLog' | 'extraLog' | 'home' | 'kitHome'>;

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
  return teamWeekOf(files, paths, { budget, now, statusUse, states });
}

/**
 * The week's W per percent as `teamrig budget` reads it: learned from the meter log, else from
 * `budget.weeklyLimitW`, which read no usage store, else the stored week's estimate; undefined while none is known.
 */
export async function readWPerPct(
  runtime: CliRuntime,
  paths: StoredWeekPaths,
  config: Pick<KitConfig, 'sessions' | 'budget'>,
  now: number,
): Promise<number | undefined> {
  const calibration = calibrationOf(await new MeterLog(runtime.files, paths.meterLog).read(now));
  return rateOf(calibration, config.budget, undefined)?.wPerPct ?? (await readStoredWeek(runtime, paths, config, now)).wPerPct;
}
