import { errorMessage } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { SessionRecordStore } from "../../sessions/record.js";
/**
 * Records where session `id` started (src/sessions/record.ts): the tab's Claude Code session, and its Claude Code
 * process, which is this hook's parent, as Claude Code starts its hooks itself (exec form, no shell). It never
 * throws: a failure is the note the start shows, and the next start records again.
 */
export async function recordSessionStart(runtime, kit, id, claudeSession) {
    try {
        const record = { claudePid: runtime.sessionProcesses.parentPid, claudeSession, at: new Date(runtime.clock.now()).toISOString() };
        await new SessionRecordStore(runtime.files, kit.paths).write(id, record);
        return undefined;
    }
    catch (error) {
        return `${KIT_NAME} could not record the Claude Code process of session ${id} (${errorMessage(error)}).`;
    }
}
