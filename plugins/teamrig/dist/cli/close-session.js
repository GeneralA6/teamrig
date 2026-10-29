import { errorMessage } from "../core/guards.js";
import { resolveKitHome } from "../core/home.js";
import { endAndWait, tabProcessOf } from "../open/end-tab.js";
import { RestoreRegistry, restoreSessionsDir } from "../restore/registry.js";
import { SessionLog } from "../sessions/log.js";
import { enderOf } from "./idle-check.js";
/**
 * Ends a closable session's Claude Code and its tab (asked, then forced: up to about 20 s) and logs the close in
 * `state/session-log.jsonl`, which `teamrig open` resumes from; why it was not closed, or undefined once it is. It
 * drops the session's restore entry too, as an end Claude Code records itself does: ending the tab leaves Claude Code
 * no time to record one, so a reboot's restore would take the closed session for one the shutdown killed (T1425).
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
        folder: closable.folder,
    });
    await dropRestoreEntry(runtime, id, closable.record.claudeSession);
    return undefined;
}
/** Takes a closed session off the restore registry; a failure only warns, as the session is closed and logged by then. */
async function dropRestoreEntry(runtime, id, claudeSession) {
    try {
        await new RestoreRegistry(runtime.files, restoreSessionsDir(resolveKitHome(runtime.env, runtime.userHome))).remove(claudeSession);
    }
    catch (error) {
        runtime.out.stderr(`WARN the restore entry of ${id} was not dropped, so a reboot's restore may reopen it: ${errorMessage(error)}`);
    }
}
