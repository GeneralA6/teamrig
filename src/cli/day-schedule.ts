import { resolveDayStart, type ResolvedDayStart } from '../wake/schedule.ts';
import { DayScheduleStore } from '../wake/schedule-store.ts';
import { fileLockOf } from './file-locks.ts';
import { rootTeamOf, type LoadedTeam } from './root-team.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The day schedule store of the tree `own` sits in: one file in the root team's state, since the root's lead plans
 * the whole tree's day. Undefined when a config up the tree does not load.
 */
export async function dayScheduleStoreOf(runtime: CliRuntime, own: LoadedTeam): Promise<DayScheduleStore | undefined> {
  const root = await rootTeamOf(runtime, own);
  if (root === undefined) {
    return undefined;
  }
  const path = root.kit.paths.daySchedule;
  return new DayScheduleStore(runtime.files, path, fileLockOf(runtime, `${path}.lock`, root.config.lock));
}

/**
 * Session `id`'s day start at `now`: its own entry in the tree's schedule over its team's, else the team's
 * `wake.dayStartUtc`. A tree whose schedule cannot be reached falls back to the config too, so a broken parent link
 * never stops a team's own day.
 */
export async function dayStartFor(runtime: CliRuntime, own: LoadedTeam, id: string, now: number): Promise<ResolvedDayStart> {
  const store = await dayScheduleStoreOf(runtime, own);
  const schedule = store === undefined ? undefined : await store.read();
  const team = own.kit.paths.team;
  return resolveDayStart(schedule, [`${team}/${id}`, team], own.config.wake.dayStartUtc, now);
}
