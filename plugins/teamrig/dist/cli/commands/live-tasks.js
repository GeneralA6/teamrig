import { errorMessage } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { liveTasksNote } from "../../hooks/live-tasks.js";
import { JsonlEventLog } from "../../register/store.js";
import { TaskTree } from "../../register/tree.js";
/**
 * Session `id`'s live-task block for its start note (hooks/live-tasks.ts), its times in the team's `zone`, from the working set of the team's register
 * log alone: no lock and no archive (a compaction retires only finished tasks), so the hook can afford it. A register
 * it cannot read gives one line that says so and names the command that lists the tasks, never a throw: the handover
 * no longer restates statuses, so the session must learn where to read them, and the note must still reach it.
 */
export async function liveTasksNoteOf(runtime, paths, id, zone) {
    try {
        const { state } = await new JsonlEventLog(runtime.files, paths.events).read();
        return liveTasksNote({ tasks: state.tasks.values(), owner: id, tree: new TaskTree(state.tasks, new Date(runtime.clock.now()), zone), command: KIT_NAME });
    }
    catch (error) {
        return `LIVE TASKS: ${KIT_NAME} could not read the register (${errorMessage(error)}); run \`${KIT_NAME} list --session ${id}\` for your tasks.`;
    }
}
