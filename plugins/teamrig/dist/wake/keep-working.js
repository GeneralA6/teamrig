import { KIT_NAME } from "../core/home.js";
import { waitContext, waitsText } from "../register/waits.js";
import { wipHold } from "../register/wip.js";
import { startableTasks } from "./day-start.js";
import { taskListText } from "./decide.js";
/**
 * What the ask sends the session to; undefined in quiet hours or while its budget holds or a short day pauses it,
 * once the task stopped waiting or changed hands, or with nothing it can start.
 */
export function keepWorkingOf(input) {
    const { tasks, elsewhere, session, ask, now, zone, rest, parking, focus, ownerSource, spentClasses } = input;
    const waiting = tasks.get(ask.task);
    if (rest.quiet || rest.held || waiting?.owner !== session || waiting.status !== 'waiting') {
        return undefined;
    }
    const context = waitContext(tasks, new Date(now), zone, elsewhere);
    const startsNow = (task) => wipHold({ task, status: 'in-progress', spentClasses }, tasks.values(), context, focus, ownerSource) === undefined;
    const startable = startableTasks(tasks, elsewhere, session, now, zone, parking).filter((task) => task.id !== waiting.id && startsNow(task));
    return startable.length === 0 ? undefined : { waiting, startable };
}
/**
 * The Stop hook's block reason: work the tasks that do not come after the waiting one, most urgent first. A lead that
 * keeps to its boundary (`leadBoundary`) hands code work to the session owning its area instead of starting it (T2822).
 */
export function keepWorkingReason(session, work, zone, handsOutCode) {
    const { waiting, startable } = work;
    const list = `plan order (\`${KIT_NAME} list --session ${session}\`)`;
    const how = handsOutCode
        ? `Hand code work to the session owning its area (\`${KIT_NAME} update <id> --owner <session>\`) and work the rest in ${list}; `
        : `Work it now in ${list}; `;
    return (`${waiting.id} waits (${waitsText(waiting.waits, zone)}), and you own work that does not come after it: ${taskListText(startable)}. ` +
        `${how}leave a task that is the same change as ${waiting.id}, and say so in one line. ` +
        'If you already work one and wait on a background step, end the turn again.');
}
