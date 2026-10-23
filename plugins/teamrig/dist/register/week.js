import { parseDayStart } from "../core/time.js";
/**
 * Which week plan is in force, read from the week tags of a register's tasks: `check`, `plan`, the meeting
 * agenda and compaction read it.
 */
/**
 * The week plan in force: the newest week tag that starts on or before now, a week tag being a day of the team's
 * `zone`. A row without a week field (a reader's own rows may lack it) counts as untagged.
 */
export function currentWeek(tasks, now, zone) {
    let best = null;
    for (const { week = null } of tasks) {
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
export function currentWeekOf(snapshot, now, zone) {
    const live = currentWeek(snapshot.state.tasks.values(), now, zone);
    const retired = snapshot.retired?.lastWeek ?? null;
    const started = retired === null ? undefined : parseDayStart(retired, zone);
    return retired !== null && started !== undefined && started.getTime() <= now.getTime() && (live === null || retired > live) ? retired : live;
}
