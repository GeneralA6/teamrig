import { resolveDayStart } from "../wake/schedule.js";
import { DayScheduleStore } from "../wake/schedule-store.js";
import { fileLockOf } from "./file-locks.js";
import { rootTeamOf } from "./root-team.js";
/**
 * The day schedule store of the tree `own` sits in: one file in the root team's state, since the root's lead plans
 * the whole tree's day. Undefined when a config up the tree does not load.
 */
export async function dayScheduleStoreOf(runtime, own) {
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
export async function dayStartFor(runtime, own, id, now) {
    const store = await dayScheduleStoreOf(runtime, own);
    const schedule = store === undefined ? undefined : await store.read();
    const team = own.kit.paths.team;
    return resolveDayStart(schedule, [`${team}/${id}`, team], own.config.wake.dayStartUtc, now);
}
