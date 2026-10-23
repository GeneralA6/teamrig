import { LiftLog } from '../budget/lift.ts';
import { addedSessionPct, liftedParts } from '../budget/parts.ts';
import { workWeights } from '../budget/work.ts';
import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import type { Task } from '../register/fold.ts';
import { otherTeamsOnAccount } from './account-teams.ts';
import type { CliRuntime } from './runtime.ts';
import { readStoredWeek, type StoredWeekPaths } from './stored-week.ts';

/**
 * What a new hire would spend a day, as `check`'s SCALE-OUT prices a slice (src/hiring/scale-out.ts): its part of the
 * account's daily budget today (src/budget/parts.ts `addedSessionPct`), beside each session's share, queued work
 * (`tasks`) and lift in force, and the other teams on the account (`otherTeamsOnAccount`). The week is read as a hook reads it (`readStoredWeek`). Undefined while the team's daily budget is unknown: no reading of the
 * week's use, or no W per percent (none learned from the meter log, no `budget.weeklyLimitW`, and a meter that does not reach
 * back to the week's start).
 */
export async function readHirePct(
  runtime: CliRuntime,
  paths: StoredWeekPaths & Pick<TeamPaths, 'team' | 'lifts'>,
  config: Pick<KitConfig, 'sessions' | 'budget' | 'register'>,
  tasks: Iterable<Task>,
  now: number,
): Promise<number | undefined> {
  const { budget, sessions } = config;
  const week = await readStoredWeek(runtime, paths, config, now);
  if (week.allowancePct === undefined) {
    return undefined;
  }
  const { lifts } = await new LiftLog(runtime.files, paths.lifts).read();
  const lifted = liftedParts(lifts, sessions, now, week.usedPct);
  const others = await otherTeamsOnAccount(runtime, { team: paths.team, config, usageDir: paths.usage }, now, week.usedPct);
  return addedSessionPct(week.allowancePct, { team: paths.team, ids: sessions, sessions: budget.sessions, work: workWeights(tasks, config.register.priorities), lifted }, others);
}
