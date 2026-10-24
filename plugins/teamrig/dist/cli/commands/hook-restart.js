import { stringField } from "../../core/guards.js";
import { ENV } from "../../core/home.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { noticeOf } from "../../refresh/decide.js";
import { claudeProcessOf, restartMayAct } from "../../refresh/restart.js";
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
/** Starts `restart` hidden for the request recorded at `at`, to wait until the session is idle; whether it started. */
async function startRunner(runtime, team, id, at, project) {
    const started = await runtime.processes.startHidden({
        command: runtime.self.node,
        args: [runtime.self.script, 'restart', id, '--team', team, '--at', at, '--project', project],
        cwd: project,
        env: runtime.env,
    });
    return started.kind === 'started';
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
        if (await startRunner(runtime, team, id, context.now, target.project)) {
            return notice;
        }
        await store.clearRestart(id);
    }
    return noticeOf(notice.state, context, false);
}
/**
 * Re-arms a restart whose runner died (T1088): a runner that gives up or is cancelled clears its request, so a
 * request no runner may act on any more (`restartMayAct`) was left by one that ended without a word, and the
 * session sits with its handover written and no fresh start. When that request was made for this tab and the
 * session still waits for its fresh start ('ready'), it is recorded again from now for the Claude Code the check
 * runs under, and a new `restart` is started for it; whether one started. One that cannot start clears the request,
 * so a failing re-arm is tried once, and a runner that dies again is re-armed at most once per give-up window.
 */
export async function rearmDeadRestart(runtime, store, scope, request) {
    const { team, id, tab, refresh, cwd } = scope;
    const now = runtime.clock.now();
    if (request === undefined || restartMayAct(request, now) || request.claudeSession !== tab || !refresh.enabled || !refresh.autoRestart) {
        return false;
    }
    if ((await store.state(id))?.phase !== 'ready') {
        return false;
    }
    // Looked up on this rare path only: each look at a process starts a PowerShell on Windows.
    const claude = await claudeProcessOf(runtime.sessionProcesses, runtime.sessionProcesses.parentPid);
    const project = runtime.env[ENV.claudeProjectDir] ?? request.cwd ?? cwd;
    if (claude !== undefined && project !== undefined) {
        const at = new Date(now).toISOString();
        await store.setRestart(id, { ...request, phase: 'pending', at, pid: claude });
        if (await startRunner(runtime, team, id, at, project)) {
            return true;
        }
    }
    await store.clearRestart(id);
    return false;
}
