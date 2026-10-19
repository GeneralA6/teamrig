import { KIT_NAME } from "../core/home.js";
import { waitsText } from "../register/waits.js";
import { startableTasks } from "./day-start.js";
import { taskListText } from "./decide.js";
/**
 * What the ask sends the session to; undefined in quiet hours or past its daily budget, once the task stopped
 * waiting or changed hands, or with nothing it can start.
 */
export function keepWorkingOf(input) {
    const { tasks, session, ask, now, rest } = input;
    const waiting = tasks.get(ask.task);
    if (rest.quiet || rest.over || waiting?.owner !== session || waiting.status !== 'waiting') {
        return undefined;
    }
    const startable = startableTasks(tasks, session, now);
    return startable.length === 0 ? undefined : { waiting, startable };
}
/** The Stop hook's block reason: work the tasks that do not come after the waiting one, most urgent first. */
export function keepWorkingReason(session, work) {
    const { waiting, startable } = work;
    return (`${waiting.id} waits (${waitsText(waiting.waits)}), and you own work that does not come after it: ${taskListText(startable)}. ` +
        `Work it now in priority order (\`${KIT_NAME} list --session ${session}\`); leave a task that is the same change as ${waiting.id}, and say so in one line. ` +
        'If you already work one and wait on a background step, end the turn again.');
}
