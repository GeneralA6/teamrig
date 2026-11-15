import { errorMessage } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { SessionRecordStore } from "../../sessions/record.js";
import { isLiveRunOwn, liveRunOf } from "../live-run.js";
const RECORDED = { failure: undefined, duplicate: undefined };
/**
 * Records where session `id`, of a team whose sessions are `ids`, started (src/sessions/record.ts): the tab's Claude
 * Code session and its transcript (undefined: the payload named none), and its Claude Code process, which is this
 * hook's parent, as Claude Code starts its hooks itself (exec form, no shell). While the session runs in another
 * Claude Code process it keeps that one's record, so wakes and closes still find the live tab: a Claude Code that one
 * started, such as a `claude -p` run inside the session, or a fork or background job of the same conversation, says
 * nothing, and any other is told to stop. It never
 * throws: a failure is the note the start shows, and the next start records again.
 */
export async function recordSessionStart(runtime, kit, ids, id, claudeSession, transcript) {
    try {
        const claudePid = runtime.sessionProcesses.parentPid;
        const live = await liveRunOf(runtime, kit.paths, ids, id, claudePid);
        if (live !== undefined) {
            // Its own tree, a fork of its conversation or the background job it handed it to is no second one.
            return { failure: undefined, duplicate: (await isLiveRunOwn(runtime, live, claudePid)) ? undefined : duplicateText(id, claudePid, live) };
        }
        const started = { claudePid, claudeSession, at: new Date(runtime.clock.now()).toISOString() };
        const record = transcript === undefined ? started : { ...started, transcript };
        await new SessionRecordStore(runtime.files, kit.paths).write(id, record);
        return RECORDED;
    }
    catch (error) {
        return { failure: `${KIT_NAME} could not record the Claude Code process of session ${id} (${errorMessage(error)}).`, duplicate: undefined };
    }
}
/** The line that stops Claude Code `claudePid`, a second one of session `id`, which runs in `live`. */
function duplicateText(id, claudePid, live) {
    return (`STOP: session ${id} already runs in Claude Code process ${live.claudePid}, so this Claude Code (process ${claudePid}) is a second one, ` +
        `which would work beside it on the same tasks; ${KIT_NAME} kept the session's record on the first. Do no work here: tell the user to use that tab and close this one.`);
}
