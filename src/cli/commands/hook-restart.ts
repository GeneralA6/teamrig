import type { RefreshConfig } from '../../config/types.ts';
import { stringField, type JsonRecord } from '../../core/guards.ts';
import { ENV } from '../../core/home.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { noticeOf, type NoticeDecision, type StopContext } from '../../refresh/decide.ts';
import { claudeProcessOf, restartMayAct } from '../../refresh/restart.ts';
import type { RestartRequest } from '../../refresh/state.ts';
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
  /** The Claude Code process the hook runs under (`claudeProcessOf`); undefined when it was not found. */
  readonly claude: number | undefined;
}

/** Starts `restart` hidden for the request recorded at `at`, to wait until the session is idle; whether it started. */
async function startRunner(runtime: CliRuntime, team: string, id: string, at: string, project: string): Promise<boolean> {
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
export async function armRestart(runtime: CliRuntime, store: RefreshStore, scope: RestartScope, notice: NoticeDecision): Promise<NoticeDecision> {
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
  return noticeOf(notice.state, context, 'clear');
}

/** The tab a dead restart is re-armed from (`rearmDeadRestart`). */
export interface RearmScope {
  readonly team: string;
  readonly id: string;
  /** The Claude Code session of the tab checking: only the tab the request was made for re-arms it. */
  readonly tab: string;
  readonly refresh: Pick<RefreshConfig, 'enabled' | 'autoRestart'>;
  /** The tab's working folder, as Claude Code gave it; undefined when it gave none. */
  readonly cwd: string | undefined;
}

/**
 * Re-arms a restart whose runner died (T1088): a runner that gives up or is cancelled clears its request, so a
 * request no runner may act on any more (`restartMayAct`) was left by one that ended without a word, and the
 * session sits with its handover written and no fresh start. When that request was made for this tab and the
 * session still waits for its fresh start ('ready'), it is recorded again from now for the Claude Code the check
 * runs under, and a new `restart` is started for it; whether one started. One that cannot start clears the request,
 * so a failing re-arm is tried once, and a runner that dies again is re-armed at most once per give-up window.
 */
export async function rearmDeadRestart(runtime: CliRuntime, store: RefreshStore, scope: RearmScope, request: RestartRequest | undefined): Promise<boolean> {
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
