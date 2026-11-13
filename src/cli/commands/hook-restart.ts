import { isEffortLevel, type EffortLevel, type KitConfig, type RefreshConfig } from '../../config/types.ts';
import { stringField, type JsonRecord } from '../../core/guards.ts';
import { ENV, type TeamPaths } from '../../core/home.ts';
import { payloadEffortOf } from '../../hooks/model-check.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { noticeOf, type NoticeDecision, type StopContext } from '../../refresh/decide.ts';
import { claudeProcessOf, restartMayAct } from '../../refresh/restart.ts';
import type { ParkedRestart, RestartRequest, RestartTab } from '../../refresh/state.ts';
import type { RefreshStore } from '../../refresh/store.ts';
import { parkRulesOf } from '../../register/park.ts';
import { startableTasks } from '../../wake/day-start.ts';
import { teamZone } from '../kit.ts';
import { isHandedOffJob, isLiveRunOwn, liveRunOf } from '../live-run.ts';
import type { CliRuntime } from '../runtime.ts';
import { teamRegister } from '../team-register.ts';

/** What the automatic restart needs from the Stop hook's payload and environment. */
export interface RestartTarget {
  readonly claudeSession: string;
  readonly transcript: string;
  readonly cwd: string | null;
  /** Where a new tab opens: Claude Code's project folder, else the session's working folder. */
  readonly project: string;
  /** The effort level the turn ran at (`payloadEffortOf`); null when the payload names none teamrig knows. */
  readonly effort: EffortLevel | null;
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
  const effort = payloadEffortOf(payload);
  return { claudeSession, transcript, cwd: cwd ?? null, project, effort: isEffortLevel(effort) ? effort : null };
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

/**
 * The Claude Code process a restart for session `id` (of a team whose sessions are `ids`) is armed against, given the
 * `claude` the hook runs under. A /clear may run in a forked worker outside the tab's process tree; signalling that
 * would kill the worker and leave the tab, so when the session's live run is another process and `claude` is a fork of
 * its conversation, the live run's tab process is the one. Otherwise `claude`, as for the background job the tab handed
 * its conversation to (`isHandedOffJob`): the job runs the session, and the restart of a background session ends no
 * process.
 */
export async function restartPidOf(runtime: CliRuntime, paths: Pick<TeamPaths, 'sessions'>, ids: readonly string[], id: string, claude: number | undefined): Promise<number | undefined> {
  if (claude === undefined) {
    return undefined;
  }
  const live = await liveRunOf(runtime, paths, ids, id, claude);
  if (live === undefined || live.tree.has(claude) || (await isHandedOffJob(runtime, live, claude))) {
    return claude;
  }
  return (await isLiveRunOwn(runtime, live, claude)) ? live.claudePid : claude;
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

/** What a restart keeps of the Stop hook's tab, the process it runs under aside. */
function restartTabOf(runtime: CliRuntime, id: string, target: RestartTarget): RestartTab {
  return { claudeSession: target.claudeSession, transcript: target.transcript, cwd: target.cwd, supervised: runtime.env[ENV.launched] === id, effort: target.effort };
}

/**
 * Whether the session has work it can start now (`startableTasks`, at any priority): a fresh start carries on with
 * it, while one without would only read its handover and sit idle until a wake, read everything again then (T1383).
 */
export async function workFollows(runtime: CliRuntime, paths: TeamPaths, config: KitConfig, id: string): Promise<boolean> {
  const { snapshot, elsewhere } = await teamRegister(runtime, paths, config).snapshotWithElsewhere();
  return startableTasks(snapshot.state.tasks, elsewhere, id, runtime.clock.now(), teamZone(config, runtime), parkRulesOf(config)).length > 0;
}

/**
 * Arms the restart a notice announces: records the pending request for the Claude Code the hook runs
 * under, then starts `restart` hidden to wait until the session is idle. When that Claude Code is not
 * found or `restart` does not start, nothing is left armed and the notice asks for /clear instead.
 */
export async function armRestart(runtime: CliRuntime, store: RefreshStore, scope: RestartScope, notice: NoticeDecision): Promise<NoticeDecision> {
  const { team, id, context, target, claude } = scope;
  if (claude !== undefined) {
    await store.setRestart(id, { ...restartTabOf(runtime, id, target), phase: 'pending', at: context.now, pid: claude });
    if (await startRunner(runtime, team, id, context.now, target.project)) {
      return notice;
    }
    await store.clearRestart(id);
  }
  return noticeOf(notice.state, context, 'clear');
}

/**
 * Holds back the restart a notice announces when no work follows the handover (`workFollows`): records it parked for
 * the tab, for the wake that brings the session work to arm (`armParkedRestart`), and says so in the notice.
 */
export async function parkRestart(runtime: CliRuntime, store: RefreshStore, scope: Omit<RestartScope, 'claude'>, notice: NoticeDecision): Promise<NoticeDecision> {
  const { id, context, target } = scope;
  await store.setParked(id, { ...restartTabOf(runtime, id, target), at: context.now });
  return noticeOf(notice.state, context, 'park');
}

/**
 * Arms the restart a notice announces when work follows the handover (`workFollows`) in the team at `register`; else
 * parks it for the wake that brings the session work (T1383).
 */
export async function restartOrPark(
  runtime: CliRuntime,
  store: RefreshStore,
  scope: RestartScope,
  notice: NoticeDecision,
  register: { readonly paths: TeamPaths; readonly config: KitConfig },
): Promise<NoticeDecision> {
  return (await workFollows(runtime, register.paths, register.config, scope.id)) ? armRestart(runtime, store, scope, notice) : parkRestart(runtime, store, scope, notice);
}

/** The tab a dead or parked restart is armed from (`rearmDeadRestart`, `armParkedRestart`). */
export interface RearmScope {
  readonly team: string;
  readonly id: string;
  /** The Claude Code session of the tab checking: only the tab the request was made for re-arms it. */
  readonly tab: string;
  readonly refresh: Pick<RefreshConfig, 'enabled' | 'autoRestart'>;
  /** The tab's working folder, as Claude Code gave it; undefined when it gave none. */
  readonly cwd: string | undefined;
  /** Where the team's session records are, and its sessions, to find the tab's own Claude Code process (`restartPidOf`). */
  readonly paths: Pick<TeamPaths, 'sessions'>;
  readonly ids: readonly string[];
}

/**
 * Records a pending restart for `tab` from now, for the Claude Code the check runs under, and starts its `restart`;
 * whether one started. One that cannot start leaves no request.
 */
async function armFromTab(runtime: CliRuntime, store: RefreshStore, scope: RearmScope, tab: RestartTab): Promise<boolean> {
  const { team, id, cwd } = scope;
  // Looked up on this rare path only: each look at a process starts a PowerShell on Windows.
  const claude = await restartPidOf(runtime, scope.paths, scope.ids, id, await claudeProcessOf(runtime.sessionProcesses, runtime.sessionProcesses.parentPid));
  const project = runtime.env[ENV.claudeProjectDir] ?? tab.cwd ?? cwd;
  if (claude !== undefined && project !== undefined) {
    const at = new Date(runtime.clock.now()).toISOString();
    await store.setRestart(id, { ...tab, phase: 'pending', at, pid: claude });
    if (await startRunner(runtime, team, id, at, project)) {
      return true;
    }
  }
  await store.clearRestart(id);
  return false;
}

/**
 * The restart parked for this tab that a wake bringing work may arm (`armParkedRestart`); undefined when none is, the
 * automatic restart being off or the record another tab's. One left after the session was refreshed some other way
 * (by hand, or a compaction that started its count over) is cleared.
 */
export async function parkedHere(store: RefreshStore, scope: RearmScope): Promise<ParkedRestart | undefined> {
  const { id, tab, refresh } = scope;
  const parked = await store.parked(id);
  if (parked === undefined || parked.claudeSession !== tab || !refresh.enabled || !refresh.autoRestart) {
    return undefined;
  }
  if ((await store.state(id))?.phase !== 'ready') {
    await store.clearParked(id);
    return undefined;
  }
  return parked;
}

/**
 * Arms the restart parked for this tab (`parkedHere`) now that a wake brings the session work: the fresh start comes
 * first, and the work, left new, wakes the fresh session (T1383). The parked record is spent either way, so a restart
 * that cannot start leaves the wake to go ahead with the context; whether one started.
 */
export async function armParkedRestart(runtime: CliRuntime, store: RefreshStore, scope: RearmScope, parked: ParkedRestart): Promise<boolean> {
  await store.clearParked(scope.id);
  return armFromTab(runtime, store, scope, parked);
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
  const { id, tab, refresh } = scope;
  if (request === undefined || restartMayAct(request, runtime.clock.now()) || request.claudeSession !== tab || !refresh.enabled || !refresh.autoRestart) {
    return false;
  }
  if ((await store.state(id))?.phase !== 'ready') {
    return false;
  }
  return armFromTab(runtime, store, scope, request);
}
