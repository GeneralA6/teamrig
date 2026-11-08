import { OUTSIDE_ID, outsideUsageDir } from '../budget/measure.ts';
import { UsageStore, type UsageState } from '../budget/store.ts';
import { calibrationOf, MeterLog, readingsOfTeam } from '../budget/calibration.ts';
import { teamWeekOf, type MeterScale } from '../budget/team-week.ts';
import { rateOf, type WeekReading } from '../budget/week.ts';
import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { accountWeekOn, type AccountWeek } from './account-teams.ts';
import type { CliRuntime } from './runtime.ts';

/** The team paths a stored reading of the week reads. */
export type StoredWeekPaths = Pick<TeamPaths, 'team' | 'usage' | 'period' | 'meterLog' | 'extraLog' | 'home' | 'kitHome'>;

/** Each session's use as last stored, by its id, then the use outside the team under OUTSIDE_ID; no transcript measured. */
export async function readStoredUsage(runtime: CliRuntime, paths: Pick<TeamPaths, 'usage'>, sessions: readonly string[]): Promise<Map<string, UsageState>> {
  const team = new UsageStore(runtime.files, paths.usage);
  const states = new Map<string, UsageState>();
  for (const id of sessions) {
    states.set(id, (await team.load(id)).state);
  }
  states.set(OUTSIDE_ID, (await new UsageStore(runtime.files, outsideUsageDir(paths.usage)).load(OUTSIDE_ID)).state);
  return states;
}

/**
 * The asking team's scale in the account's meter log (budget/team-week.ts `MeterScale`): its own lines, the keeper's
 * untagged ones when it is the keeper, and the other teams on the account with their usage stores as last stored,
 * read only when a crossing is logged.
 */
export function meterScaleOf(runtime: CliRuntime, team: string, account: Pick<AccountWeek, 'keeper' | 'peers'>): MeterScale {
  return {
    team,
    keeper: account.keeper,
    peers: async () =>
      Promise.all(account.peers.map(async (peer) => ({ team: peer.team, states: [...(await readStoredUsage(runtime, peer, peer.ids)).values()] }))),
  };
}

/**
 * The week as a hook reads it: each session's use as last stored, the use outside the team and the newest
 * status-line reading on the account, in the account's week files (`accountWeekOn`), no transcript measured.
 */
export async function readStoredWeek(
  runtime: CliRuntime,
  paths: StoredWeekPaths,
  config: Pick<KitConfig, 'sessions' | 'budget'>,
  now: number,
): Promise<WeekReading> {
  return storedWeekOn(runtime, paths, config, now, await accountWeekOn(runtime, config.budget, paths, now));
}

async function storedWeekOn(
  runtime: CliRuntime,
  paths: Pick<TeamPaths, 'team' | 'usage'>,
  config: Pick<KitConfig, 'sessions' | 'budget'>,
  now: number,
  account: AccountWeek,
): Promise<WeekReading> {
  const { budget, sessions } = config;
  const states = [...(await readStoredUsage(runtime, paths, sessions)).values()];
  return teamWeekOf(runtime.files, account.paths, meterScaleOf(runtime, paths.team, account), { budget, now, statusUse: account.statusUse, states });
}

/**
 * The week's W per percent as `teamrig budget` reads it: learned from the team's lines of the account's meter log
 * (`accountWeekOn`, `readingsOfTeam`), else
 * from `budget.weeklyLimitW`, which read no usage store, else the stored week's estimate; undefined while none is known.
 * It prices a spend over several days (a task's size); a spend made now takes `readTodayWPerPct`.
 */
export async function readWPerPct(
  runtime: CliRuntime,
  paths: StoredWeekPaths,
  config: Pick<KitConfig, 'sessions' | 'budget'>,
  now: number,
): Promise<number | undefined> {
  const account = await accountWeekOn(runtime, config.budget, paths, now);
  const logged = await new MeterLog(runtime.files, account.paths.meterLog).read(now);
  const calibration = calibrationOf(readingsOfTeam(logged, { team: paths.team, keeper: account.keeper }));
  return rateOf(calibration, config.budget, undefined)?.wPerPct ?? (await storedWeekOn(runtime, paths, config, now, account)).wPerPct;
}

/**
 * Today's W per percent of the week, as `teamrig budget` prices today's rows (budget/report.ts): today's W over the
 * status line's points today once they span `TODAY_RATE_SPAN_PTS`, else the week's rate (`readWPerPct`'s order);
 * undefined while no rate is known. It prices a spend made now, as a wake.
 */
export async function readTodayWPerPct(
  runtime: CliRuntime,
  paths: StoredWeekPaths,
  config: Pick<KitConfig, 'sessions' | 'budget'>,
  now: number,
): Promise<number | undefined> {
  return (await readStoredWeek(runtime, paths, config, now)).todayWPerPct;
}
