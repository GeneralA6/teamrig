import { endAndWait, tabProcessOf } from "../open/end-tab.js";
import { SessionLog } from "../sessions/log.js";
import { enderOf } from "./idle-check.js";
/**
 * Ends a closable session's Claude Code and its tab (asked, then forced: up to about 20 s) and logs the close in
 * `state/session-log.jsonl`, which `teamrig open` resumes from; why it was not closed, or undefined once it is.
 */
export async function closeSession(runtime, paths, closing) {
    const { id, by, closable } = closing;
    const ender = enderOf(runtime);
    const problem = await endAndWait(ender, await tabProcessOf(ender, closable.claude), closable.claude.pid);
    if (problem !== undefined) {
        return problem;
    }
    await new SessionLog(runtime.files, paths.sessionLog).append({
        kind: 'close',
        session: id,
        by,
        at: new Date(runtime.clock.now()).toISOString(),
        claudeSession: closable.record.claudeSession,
        idleMinutes: closable.idleMinutes,
        freedMb: closable.heldMb,
    });
    return undefined;
}
