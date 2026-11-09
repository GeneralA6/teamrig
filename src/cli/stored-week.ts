import { OUTSIDE_ID, outsideUsageDir } from '../budget/measure.ts';
import { UsageStore, type UsageState } from '../budget/store.ts';
import { accountReadings, calibrationOf, MeterLog } from '../budget/calibration.ts';
import { teamWeekOf } from '../budget/team-week.ts';
import { rateOf, type WeekReading } from '../budget/week.ts';
import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import { accountWeekOn, type AccountPeer, type AccountWeek } from './account-teams.ts';
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
 * The session stores of the other teams on the account (`AccountWeek.peers`) as last stored, which the account's W
 * counts (budget/team-week.ts `teamWeekOf`, T1778). Never a peer's outside store: it holds the same use in no team as
 * the asking team's, so the account's W would count it twice.
 */
export async function peerStatesOf(runtime: CliRuntime, peers: readonly AccountPeer[]): Promise<UsageState[]> {
  const byPeer = await Promise.all(
    peers.map(async (peer) => {
      const store = new UsageStore(runtime.files, peer.usage);
      return Promise.all(peer.ids.map(async (id) => (await store.load(id)).state));
    }),
  );
  return byPeer.flat();
}

/**
 * The week as a hook reads it: each session's use as last stored, the use outside the team, the other teams'
 * sessions on the account (`peerStatesOf`) and the newest status-line reading on the account, in the account's week
 * files (`accountWeekOn`), no transcript measured.
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
  const states = [...(await readStoredUsage(runtime, paths, sessions)).values(), ...(await peerStatesOf(runtime, account.peers))];
  return teamWeekOf(runtime.files, account, { budget, now, statusUse: account.statusUse, states });
}

/**
 * The week's W per percent as `teamrig budget` reads it: learned from the account's lines of its meter log
 * (`accountWeekOn`, `accountReadings`), else
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
  const calibration = calibrationOf(accountReadings(logged, account.keeper));
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
