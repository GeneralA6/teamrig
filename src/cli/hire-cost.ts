import { join } from 'node:path';
import { LiftLog } from '../budget/lift.ts';
import { OUTSIDE_ID } from '../budget/measure.ts';
import { addedSessionPct, liftedParts } from '../budget/parts.ts';
import { PeriodStore } from '../budget/period.ts';
import { readSnapshots, weekUseOf } from '../budget/snapshot.ts';
import { UsageStore, type UsageState } from '../budget/store.ts';
import { meteredOf, readWeek } from '../budget/week.ts';
import { workWeights } from '../budget/work.ts';
import type { KitConfig } from '../config/types.ts';
import type { TeamPaths } from '../core/home.ts';
import type { Task } from '../register/fold.ts';
import { snapshotDirOf } from './commands/budget.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * What a new hire would spend a day, as `check`'s SCALE-OUT prices a slice (src/hiring/scale-out.ts): its part of the
 * team's daily budget today (src/budget/parts.ts `addedSessionPct`), beside each session's share, queued work
 * (`tasks`) and lift in force. The week is read as a hook reads it: each session's use as last stored and the newest
 * status-line reading, no transcript measured. Undefined while the team's daily budget is unknown: no reading of the
 * week's use, or no W per percent (no `budget.weeklyLimitW`, and a meter that does not reach back to the week's start).
 */
export async function readHirePct(
  runtime: CliRuntime,
  paths: Pick<TeamPaths, 'usage' | 'period' | 'lifts' | 'home' | 'kitHome'>,
  config: Pick<KitConfig, 'sessions' | 'budget' | 'register'>,
  tasks: Iterable<Task>,
  now: number,
): Promise<number | undefined> {
  const { files } = runtime;
  const { budget, sessions } = config;
  const team = new UsageStore(files, paths.usage);
  const states: UsageState[] = [];
  for (const id of sessions) {
    states.push((await team.load(id)).state);
  }
  states.push((await new UsageStore(files, join(paths.usage, 'outside')).load(OUTSIDE_ID)).state);
  const snapshots = await readSnapshots(files, snapshotDirOf(budget, paths));
  const statusUse = weekUseOf(snapshots, now);
  const period = await new PeriodStore(files, paths.period).periodAt(budget, statusUse, now, meteredOf(budget, states, now));
  const week = readWeek({ budget, now, statusUse, period, states });
  if (week.allowancePct === undefined) {
    return undefined;
  }
  const { lifts } = await new LiftLog(files, paths.lifts).read();
  const lifted = liftedParts(lifts, sessions, now, week.usedPct);
  return addedSessionPct(week.allowancePct, { ids: sessions, sessions: budget.sessions, work: workWeights(tasks, config.register.priorities), lifted });
}
