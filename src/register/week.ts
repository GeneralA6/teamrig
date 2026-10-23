import { parseDayStart } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Task } from './fold.ts';
import type { RegisterSnapshot } from './snapshot.ts';

/**
 * Which week plan is in force, read from the week tags of a register's tasks: `check`, `plan`, the meeting
 * agenda and compaction read it.
 */

/**
 * The week plan in force: the newest week tag that starts on or before now, a week tag being a day of the team's
 * `zone`.
 */
export function currentWeek(tasks: Iterable<Task>, now: Date, zone: TimeZone): string | null {
  let best: string | null = null;
  for (const { week } of tasks) {
    const start = week === null ? undefined : parseDayStart(week, zone);
    if (week !== null && start !== undefined && start.getTime() <= now.getTime() && (best === null || week > best)) {
      best = week;
    }
  }
  return best;
}

/**
 * The week plan in force over a register as read: `currentWeek` of its tasks, or the newest week of
 * the tasks a compaction retired when that is newer, as a replay of the whole history would find it.
 */
export function currentWeekOf(snapshot: RegisterSnapshot, now: Date, zone: TimeZone): string | null {
  const live = currentWeek(snapshot.state.tasks.values(), now, zone);
  const retired = snapshot.retired?.lastWeek ?? null;
  const started = retired === null ? undefined : parseDayStart(retired, zone);
  return retired !== null && started !== undefined && started.getTime() <= now.getTime() && (live === null || retired > live) ? retired : live;
}
