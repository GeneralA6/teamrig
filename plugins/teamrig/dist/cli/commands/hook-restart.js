import { stringField } from "../../core/guards.js";
import { ENV } from "../../core/home.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { noticeOf } from "../../refresh/decide.js";
/** The restart's target; undefined when Claude Code did not give its session, its transcript or a folder. */
export function restartTargetOf(runtime, payload) {
    const claudeSession = sessionIdOf(payload);
    const transcript = stringField(payload, 'transcript_path');
    const cwd = stringField(payload, 'cwd');
    const project = runtime.env[ENV.claudeProjectDir] ?? cwd;
    if (claudeSession === null || transcript === undefined || project === undefined) {
        return undefined;
    }
    return { claudeSession, transcript, cwd: cwd ?? null, project };
}
/**
 * Arms the restart a notice announces: records the pending request for the Claude Code the hook runs
 * under, then starts `restart` hidden to wait until the session is idle. When that Claude Code is not
 * found or `restart` does not start, nothing is left armed and the notice asks for /clear instead.
 */
export async function armRestart(runtime, store, scope, notice) {
    const { team, id, context, target, claude } = scope;
    if (claude !== undefined) {
        await store.setRestart(id, {
            phase: 'pending',
            at: context.now,
            pid: claude,
            claudeSession: target.claudeSession,
            transcript: target.transcript,
            cwd: target.cwd,
            supervised: runtime.env[ENV.launched] === id,
        });
        const started = await runtime.processes.startHidden({
            command: runtime.self.node,
            args: [runtime.self.script, 'restart', id, '--team', team, '--at', context.now, '--project', target.project],
            cwd: target.project,
            env: runtime.env,
        });
        if (started.kind === 'started') {
            return notice;
        }
        await store.clearRestart(id);
    }
    return noticeOf(notice.state, context, false);
}
