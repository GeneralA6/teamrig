import { taskUseOf } from '../budget/task-use.ts';
import type { KitConfig } from '../config/types.ts';
import type { CliRuntime } from './runtime.ts';
import { readStoredUsage, readWPerPct, type StoredWeekPaths } from './stored-week.ts';

/**
 * What each task cost, in percent of the weekly limit, for `check`'s OVER-SIZE (src/register/over-size.ts): the W its
 * sessions' turns spent on it in the days the meter keeps, open turns' share included (`taskUseOf`), as each session's
 * use was last stored (`budget --task` measures the transcripts now), over the W of one percent. Undefined while
 * that rate is unknown: none learned from the meter log, no `budget.weeklyLimitW`, and no stored week to learn it from.
 */
export async function readTaskSpend(
  runtime: CliRuntime,
  paths: StoredWeekPaths,
  config: Pick<KitConfig, 'sessions' | 'budget'>,
  now: number,
): Promise<((task: string) => number) | undefined> {
  const wPerPct = await readWPerPct(runtime, paths, config, now);
  if (wPerPct === undefined || wPerPct <= 0) {
    return undefined;
  }
  const states = await readStoredUsage(runtime, paths, config.sessions);
  return (task) => taskUseOf(states, task).w / wPerPct;
}
