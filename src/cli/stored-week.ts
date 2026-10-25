import { join } from 'node:path';
import { OUTSIDE_ID } from '../budget/measure.ts';
import { weekUseOf } from '../budget/snapshot.ts';
import { UsageStore, type UsageState } from '../budget/store.ts';
import { calibrationOf, MeterLog } from '../budget/calibration.ts';
import { teamWeekOf } from '../budget/team-week.ts';
import { rateOf, type WeekReading } from '../budget/week.ts';
import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { snapshotsOnAccount } from './account-teams.ts';
import type { CliRuntime } from './runtime.ts';

/** The team paths a stored reading of the week reads. */
export type StoredWeekPaths = Pick<TeamPaths, 'usage' | 'period' | 'meterLog' | 'extraLog' | 'home' | 'kitHome'>;

/** Each session's use as last stored, by its id, then the use outside the team under OUTSIDE_ID; no transcript measured. */
export async function readStoredUsage(runtime: CliRuntime, paths: Pick<TeamPaths, 'usage'>, sessions: readonly string[]): Promise<Map<string, UsageState>> {
  const team = new UsageStore(runtime.files, paths.usage);
  const states = new Map<string, UsageState>();
  for (const id of sessions) {
    states.set(id, (await team.load(id)).state);
  }
  states.set(OUTSIDE_ID, (await new UsageStore(runtime.files, join(paths.usage, 'outside')).load(OUTSIDE_ID)).state);
  return states;
}

/**
 * The week as a hook reads it: each session's use as last stored, the use outside the team and the newest
 * status-line reading on the account (`snapshotsOnAccount`), no transcript measured.
 */
export async function readStoredWeek(
  runtime: CliRuntime,
  paths: StoredWeekPaths,
  config: Pick<KitConfig, 'sessions' | 'budget'>,
  now: number,
): Promise<WeekReading> {
  const { budget, sessions } = config;
  const states = [...(await readStoredUsage(runtime, paths, sessions)).values()];
  const statusUse = weekUseOf(await snapshotsOnAccount(runtime, budget, paths), now);
  return teamWeekOf(runtime.files, paths, { budget, now, statusUse, states });
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
