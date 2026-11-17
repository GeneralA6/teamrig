import { JsonlEventLog } from "../register/store.js";
import { lineFrontPath, LineFrontStore } from "./line-front-store.js";
import { lineRequestOf } from "./process-request.js";
/**
 * The line requests of one team's steps as they stand at each read (T4082): the priority and class of the task each
 * names, by `taskOf`, and the team's front, read from `front` every time, so a task raised, or put at the front, while
 * its step waits moves that step at its next read.
 */
export function requestSourceOf(taskOf, front, focus) {
    return {
        async current(request) {
            return lineRequestOf(request, taskOf, focus, await front.read());
        },
    };
}
/**
 * The line requests of the team at `paths`: its register's tasks, read again at each call, and the front its lead put
 * in its state folder (`teamrig pipeline front`). Each team reads only its own register and front, so a lead fronts
 * only its own team's tasks.
 */
export function teamRequestsOf(files, paths, focus) {
    const register = new JsonlEventLog(files, paths.events);
    return requestSourceOf(async (id) => (await register.read()).state.tasks.get(id), new LineFrontStore(files, lineFrontPath(paths.state)), focus);
}
