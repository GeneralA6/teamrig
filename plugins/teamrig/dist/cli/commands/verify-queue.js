import { JsonlDailyLog } from "../../core/daily-log.js";
import { KIT_NAME } from "../../core/home.js";
import { JsonlEventLog } from "../../register/store.js";
import { verifyByArrived, verifyQueue, watchQueue } from "../../register/verify.js";
import { formatVerifyByLine, formatVerifySummary, verifySummaryPointer } from "../../register/views.js";
/**
 * The tasks of the team's register log's working set alone: no lock and no archive (a compaction retires only
 * finished tasks with no watch), so a hook can afford it.
 */
async function workingTasksOf(runtime, paths) {
    const snapshot = await new JsonlEventLog(runtime.files, paths.events).read();
    return [...snapshot.state.tasks.values()];
}
/**
 * `VERIFY <n>, oldest first:` and a row per verifying task, then a `WATCH` line for its watched done tasks
 * (formatVerifySummary) for a session that holds some, for its start context and `inbox read`; undefined for none,
 * and when the register cannot be read, so its caller never fails on it.
 */
export async function verifyNoteOf(runtime, paths, id) {
    if (id === undefined) {
        return undefined;
    }
    try {
        const tasks = await workingTasksOf(runtime, paths);
        return formatVerifySummary(verifyQueue(tasks, id), watchQueue(tasks, id), id, KIT_NAME);
    }
    catch {
        return undefined;
    }
}
/** verifyNoteOf for the start note, with the pointer a start shows when it has no room for the rows (T1376). */
export async function verifyStartNoteOf(runtime, paths, id) {
    const text = await verifyNoteOf(runtime, paths, id);
    return text === undefined || id === undefined ? undefined : { text, pointer: verifySummaryPointer(id, KIT_NAME) };
}
/**
 * The Stop hook's lines for session `id`'s verifying tasks whose verify-by day has come, overdue ones
 * too. It reads the register at the session's first stop of each UTC day only, so each task gets one
 * line a day and every other stop reads one small file; a date that arrives later that day waits for
 * the next one.
 */
export async function verifyByLinesOf(runtime, paths, id, zone) {
    const now = new Date(runtime.clock.now());
    const scans = new JsonlDailyLog(runtime.files, paths.verifyNotices);
    const key = `due ${id}`;
    if (await scans.seen(key, now)) {
        return [];
    }
    const due = verifyQueue(await workingTasksOf(runtime, paths), id).filter((task) => verifyByArrived(task, now, zone));
    await scans.record(key, now);
    return due.map((task) => formatVerifyByLine(task, zone));
}
