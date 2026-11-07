import { spentSince, taskUseOf, taskUseReader, wByDay } from "../budget/task-use.js";
import { formatUtcDay } from "../core/time.js";
import { readStoredUsage, readWPerPct } from "./stored-week.js";
/**
 * What each task cost since its size was set, in percent of the weekly limit, for `check`'s OVER-SIZE
 * (src/register/over-size.ts): the W its sessions' turns spent on it in the days the meter keeps, open turns' share
 * included (`taskUseReader`), as each session's use was last stored (`budget --task` measures the transcripts now), past
 * its size base (`spentSince`), over the W of one percent. Undefined while that rate is unknown: none learned from the
 * meter log, no `budget.weeklyLimitW`, and no stored week to learn it from.
 */
export async function readTaskSpend(runtime, paths, config, now) {
    const wPerPct = await readWPerPct(runtime, paths, config, now);
    if (wPerPct === undefined || wPerPct <= 0) {
        return undefined;
    }
    const useOf = taskUseReader(await readStoredUsage(runtime, paths, config.sessions));
    return (task) => spentSince(useOf(task.id), task.sizeBase) / wPerPct;
}
/**
 * The size base an `update --size` writes (T649): the W the meter counts on `task` on today's UTC day so far, as each
 * session's use was last stored, so a turn the meter has not stored yet counts after the size, as spend on what is left.
 */
export async function readSizeBase(runtime, paths, sessions, task, now) {
    const day = formatUtcDay(new Date(now));
    const use = taskUseOf(await readStoredUsage(runtime, paths, sessions), task);
    return { day, w: wByDay(use).get(day) ?? 0 };
}
