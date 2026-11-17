import { isRecord } from "../core/guards.js";
import { TASK_ID } from "../register/model.js";
/** The team's front file, in its state folder: each team's lead fronts only its own team's tasks. */
export const LINE_FRONT_FILE = 'line-front.json';
/** A front as its file stores it; a field another kit adds is ignored. */
export function isLineFront(value) {
    if (!isRecord(value)) {
        return false;
    }
    const { task, at, by } = value;
    return typeof task === 'string' && TASK_ID.test(task) && typeof at === 'string' && !Number.isNaN(Date.parse(at)) && typeof by === 'string';
}
