import { taskUseOf, type TaskUse } from '../budget/task-use.ts';
import type { KitConfig } from '../config/types.ts';
import { formatUtcDay } from '../core/time.ts';
import type { SizeBase } from '../register/events.ts';
import type { Task } from '../register/fold.ts';
import type { CliRuntime } from './runtime.ts';
import { readStoredUsage, readWPerPct, type StoredWeekPaths } from './stored-week.ts';

/** The W of a task's use per UTC day, its sessions' summed. */
function wByDay(use: TaskUse): Map<string, number> {
  const days = new Map<string, number>();
  for (const session of use.sessions) {
    for (const [day, w] of Object.entries(session.byDay)) {
      days.set(day, (days.get(day) ?? 0) + w);
    }
  }
  return days;
}

/**
 * The W a task spent since its size was set (T649): with no base, all the meter keeps on it; else the days after the
 * base's day in full, and on that day what it spent past the base's W. A day before it counts nothing, so a base whose
 * day the meter no longer keeps counts only the days after it.
 */
export function spentSince(use: TaskUse, base: SizeBase | null): number {
  if (base === null) {
    return use.w;
  }
  let spent = 0;
  for (const [day, w] of wByDay(use)) {
    if (day > base.day) {
      spent += w;
    } else if (day === base.day) {
      spent += Math.max(0, w - base.w);
    }
  }
  return spent;
}

/**
 * What each task cost since its size was set, in percent of the weekly limit, for `check`'s OVER-SIZE
 * (src/register/over-size.ts): the W its sessions' turns spent on it in the days the meter keeps, open turns' share
 * included (`taskUseOf`), as each session's use was last stored (`budget --task` measures the transcripts now), past
 * its size base (`spentSince`), over the W of one percent. Undefined while that rate is unknown: none learned from the
 * meter log, no `budget.weeklyLimitW`, and no stored week to learn it from.
 */
export async function readTaskSpend(
  runtime: CliRuntime,
  paths: StoredWeekPaths,
  config: Pick<KitConfig, 'sessions' | 'budget'>,
  now: number,
): Promise<((task: Pick<Task, 'id' | 'sizeBase'>) => number) | undefined> {
  const wPerPct = await readWPerPct(runtime, paths, config, now);
  if (wPerPct === undefined || wPerPct <= 0) {
    return undefined;
  }
  const states = await readStoredUsage(runtime, paths, config.sessions);
  return (task) => spentSince(taskUseOf(states, task.id), task.sizeBase) / wPerPct;
}

/**
 * The size base an `update --size` writes (T649): the W the meter counts on `task` on today's UTC day so far, as each
 * session's use was last stored, so a turn the meter has not stored yet counts after the size, as spend on what is left.
 */
export async function readSizeBase(runtime: CliRuntime, paths: StoredWeekPaths, sessions: readonly string[], task: string, now: number): Promise<SizeBase> {
  const day = formatUtcDay(new Date(now));
  const use = taskUseOf(await readStoredUsage(runtime, paths, sessions), task);
  return { day, w: wByDay(use).get(day) ?? 0 };
}
