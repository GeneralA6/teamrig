import { isRightNow } from "../config/priorities.js";
import { isActive } from "../register/stats.js";
import { holderOf } from "./groups.js";
const TASK_IDS = /\bT\d+\b/g;
/**
 * The first task `text` names by id (`T<n>`) that is right-now work (p0 or more urgent) and not finished, each id read
 * as team `reader` reads it (its own register first, T1139); undefined when it names none. A line about such work goes
 * out as `inbox add --wake now` (T4414): right-now work never waits for the receiver's next prompt. A finished task
 * counts for nothing, so a line saying the work is done, sent after its status, wakes no one.
 */
export function rightNowNamedIn(text, registers, reader) {
    for (const [id] of text.matchAll(TASK_IDS)) {
        const holder = holderOf(registers, reader, id);
        const task = registers.find((register) => register.team === holder)?.tasks.get(id);
        if (task !== undefined && isActive(task.status) && isRightNow(task.priority)) {
            return task;
        }
    }
    return undefined;
}
