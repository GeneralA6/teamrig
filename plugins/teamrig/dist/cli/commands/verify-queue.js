import { JsonlDailyLog } from "../../core/daily-log.js";
import { JsonlEventLog } from "../../register/store.js";
import { verifyByArrived, verifyQueue } from "../../register/verify.js";
import { formatVerifyByLine, formatVerifySummary } from "../../register/views.js";
/**
 * The verifying tasks of session `id`, oldest first, from the working set of the team's register log
 * alone: no lock and no archive (a compaction retires only finished tasks), so a hook can afford it.
 */
async function queueOf(runtime, paths, id) {
    const snapshot = await new JsonlEventLog(runtime.files, paths.events).read();
    return verifyQueue(snapshot.state.tasks.values(), id);
}
/**
 * `VERIFY <n>: T1 (proof: ...), ...` for a session with verifying tasks, for its start context and
 * `inbox read`; undefined for none, and when the register cannot be read, so its caller never fails on it.
 */
export async function verifyNoteOf(runtime, paths, id) {
    if (id === undefined) {
        return undefined;
    }
    try {
        return formatVerifySummary(await queueOf(runtime, paths, id));
    }
    catch {
        return undefined;
    }
}
/**
 * The Stop hook's lines for session `id`'s verifying tasks whose verify-by day has come, overdue ones
 * too. It reads the register at the session's first stop of each UTC day only, so each task gets one
 * line a day and every other stop reads one small file; a date that arrives later that day waits for
 * the next one.
 */
export async function verifyByLinesOf(runtime, paths, id) {
    const now = new Date(runtime.clock.now());
    const scans = new JsonlDailyLog(runtime.files, paths.verifyNotices);
    const key = `due ${id}`;
    if (await scans.seen(key, now)) {
        return [];
    }
    const due = (await queueOf(runtime, paths, id)).filter((task) => verifyByArrived(task, now));
    await scans.record(key, now);
    return due.map(formatVerifyByLine);
}
