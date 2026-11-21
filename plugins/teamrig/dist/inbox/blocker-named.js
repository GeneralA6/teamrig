import { BLOCKER_PRIORITY_ID } from "../register/model.js";
import { isActive } from "../register/stats.js";
import { holderOf } from "./groups.js";
const TASK_IDS = /\bT\d+\b/g;
/**
 * The first task `text` names by id (`T<n>`) that is an unfinished blocker, each id read as team `reader` reads it
 * (its own register first, T1139); undefined when it names none. A line about a blocker goes out as `inbox add --wake
 * now` (T4414): a blocker never waits for the receiver's next prompt. p0 work does not (T4329): it reaches its
 * receiver through the normal wake gate, as work it can go on with, so a stream of p0 lines does not spend a woken turn
 * each. A finished task counts for nothing, so a line saying the work is done, sent after its status, wakes no one.
 */
export function blockerNamedIn(text, registers, reader) {
    for (const [id] of text.matchAll(TASK_IDS)) {
        const holder = holderOf(registers, reader, id);
        const task = registers.find((register) => register.team === holder)?.tasks.get(id);
        if (task !== undefined && isActive(task.status) && task.priority === BLOCKER_PRIORITY_ID) {
            return task;
        }
    }
    return undefined;
}
