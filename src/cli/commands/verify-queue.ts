import { JsonlDailyLog } from '../../core/daily-log.ts';
import { KIT_NAME, type TeamPaths } from '../../core/home.ts';
import type { TimeZone } from '../../core/zone.ts';
import type { Task } from '../../register/fold.ts';
import { JsonlEventLog } from '../../register/store.ts';
import { verifyByArrived, verifyQueue } from '../../register/verify.ts';
import { formatVerifyByLine, formatVerifySummary } from '../../register/views.ts';
import type { CliRuntime } from '../runtime.ts';

/**
 * The verifying tasks of session `id`, oldest first, from the working set of the team's register log
 * alone: no lock and no archive (a compaction retires only finished tasks), so a hook can afford it.
 */
async function queueOf(runtime: CliRuntime, paths: TeamPaths, id: string): Promise<Task[]> {
  const snapshot = await new JsonlEventLog(runtime.files, paths.events).read();
  return verifyQueue(snapshot.state.tasks.values(), id);
}

/**
 * `VERIFY <n>, oldest first:` and a row per verifying task (formatVerifySummary) for a session that holds some, for
 * its start context and `inbox read`; undefined for none, and when the register cannot be read, so its caller never
 * fails on it.
 */
export async function verifyNoteOf(runtime: CliRuntime, paths: TeamPaths, id: string | undefined): Promise<string | undefined> {
  if (id === undefined) {
    return undefined;
  }
  try {
    return formatVerifySummary(await queueOf(runtime, paths, id), id, KIT_NAME);
  } catch {
    return undefined;
  }
}

/**
 * The Stop hook's lines for session `id`'s verifying tasks whose verify-by day has come, overdue ones
 * too. It reads the register at the session's first stop of each UTC day only, so each task gets one
 * line a day and every other stop reads one small file; a date that arrives later that day waits for
 * the next one.
 */
export async function verifyByLinesOf(runtime: CliRuntime, paths: TeamPaths, id: string, zone: TimeZone): Promise<string[]> {
  const now = new Date(runtime.clock.now());
  const scans = new JsonlDailyLog(runtime.files, paths.verifyNotices);
  const key = `due ${id}`;
  if (await scans.seen(key, now)) {
    return [];
  }
  const due = (await queueOf(runtime, paths, id)).filter((task) => verifyByArrived(task, now, zone));
  await scans.record(key, now);
  return due.map((task) => formatVerifyByLine(task, zone));
}
