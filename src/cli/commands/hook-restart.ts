import { stringField, type JsonRecord } from '../../core/guards.ts';
import { ENV } from '../../core/home.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { noticeOf, type NoticeDecision, type StopContext } from '../../refresh/decide.ts';
import { claudeProcessOf } from '../../refresh/restart.ts';
import type { RefreshStore } from '../../refresh/store.ts';
import type { CliRuntime } from '../runtime.ts';

/** What the automatic restart needs from the Stop hook's payload and environment. */
export interface RestartTarget {
  readonly claudeSession: string;
  readonly transcript: string;
  readonly cwd: string | null;
  /** Where a new tab opens: Claude Code's project folder, else the session's working folder. */
  readonly project: string;
}

/** The restart's target; undefined when Claude Code did not give its session, its transcript or a folder. */
export function restartTargetOf(runtime: CliRuntime, payload: JsonRecord): RestartTarget | undefined {
  const claudeSession = sessionIdOf(payload);
  const transcript = stringField(payload, 'transcript_path');
  const cwd = stringField(payload, 'cwd');
  const project = runtime.env[ENV.claudeProjectDir] ?? cwd;
  if (claudeSession === null || transcript === undefined || project === undefined) {
    return undefined;
  }
  return { claudeSession, transcript, cwd: cwd ?? null, project };
}

/** The session a restart is armed for. */
export interface RestartScope {
  readonly team: string;
  readonly id: string;
  readonly context: StopContext;
  readonly target: RestartTarget;
}

/**
 * Arms the restart a notice announces: records the pending request for the Claude Code the hook runs
 * under, then starts `restart` hidden to wait until the session is idle. When that Claude Code is not
 * found or `restart` does not start, nothing is left armed and the notice asks for /clear instead.
 */
export async function armRestart(runtime: CliRuntime, store: RefreshStore, scope: RestartScope, notice: NoticeDecision): Promise<NoticeDecision> {
  const { team, id, context, target } = scope;
  const claude = await claudeProcessOf(runtime.sessionProcesses, runtime.sessionProcesses.parentPid);
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
