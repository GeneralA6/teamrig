import { isEffortLevel } from "../../config/types.js";
import { stringField } from "../../core/guards.js";
import { ENV } from "../../core/home.js";
import { payloadEffortOf } from "../../hooks/model-check.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { CARRY_TAIL_BYTES, carryOf } from "../../refresh/carry.js";
import { noticeOf } from "../../refresh/decide.js";
import { claudeProcessOf, restartMayAct } from "../../refresh/restart.js";
import { parkRulesOf } from "../../register/park.js";
import { startableTasks } from "../../wake/day-start.js";
import { teamZone } from "../kit.js";
import { teamRegister } from "../team-register.js";
/** The restart's target; undefined when Claude Code did not give its session, its transcript or a folder. */
export function restartTargetOf(runtime, payload) {
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
/** What a restart keeps of the Stop hook's tab, the process it runs under aside. */
function restartTabOf(runtime, id, target) {
    return { claudeSession: target.claudeSession, transcript: target.transcript, cwd: target.cwd, supervised: runtime.env[ENV.launched] === id, effort: target.effort };
}
/**
 * Whether the session has work it can start now (`startableTasks`, at any priority): a fresh start carries on with
 * it, while one without would only read its handover and sit idle until a wake, read everything again then (T1383).
 */
export async function workFollows(runtime, paths, config, id) {
    const { snapshot, elsewhere } = await teamRegister(runtime, paths, config).snapshotWithElsewhere();
    return startableTasks(snapshot.state.tasks, elsewhere, id, runtime.clock.now(), teamZone(config, runtime), parkRulesOf(config)).length > 0;
}
/**
 * Arms the restart a notice announces: records the pending request for the Claude Code the hook runs
 * under, then starts `restart` hidden to wait until the session is idle. When that Claude Code is not
 * found or `restart` does not start, nothing is left armed and the notice asks for /clear instead.
 */
export async function armRestart(runtime, store, scope, notice) {
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
export async function parkRestart(runtime, store, scope, notice) {
    const { id, context, target } = scope;
    await store.setParked(id, { ...restartTabOf(runtime, id, target), at: context.now });
    return noticeOf(notice.state, context, 'park');
}
/**
 * Whether the session's next turn comes whether or not a task wake brings it work: the lead, which the owner, its inbox
 * and its own checks wake, or a session whose transcript (at `transcript`) still has a live recurring scheduled job
 * (CronCreate, counting those an earlier /clear left in its process: `refresh/carry.ts`). A restart held back for a
 * wake (T1383) never comes for such a session: the scheduled turn goes on from the full context, which drops the
 * held-back restart, and every later fire reads that whole context again. Read only at a notice, not at every stop.
 */
export async function wokenAnyway(runtime, store, config, id, transcript) {
    if (config.roles.lead === id) {
        return true;
    }
    const text = transcript === undefined ? undefined : await runtime.files.readTail(transcript, CARRY_TAIL_BYTES);
    if (text === undefined) {
        return false;
    }
    const record = await store.carried(id);
    const inherited = record !== undefined && record.transcript === transcript ? record.crons : [];
    return carryOf(text, runtime.clock.now(), inherited).crons.some((cron) => cron.recurring);
}
/**
 * Arms the restart a notice announces when work follows the handover (`workFollows`) in the team at `register`, or when
 * the session is woken anyway (`wokenAnyway`); else parks it for the wake that brings the session work (T1383).
 */
export async function restartOrPark(runtime, store, scope, notice, register) {
    const arm = (await workFollows(runtime, register.paths, register.config, scope.id)) || (await wokenAnyway(runtime, store, register.config, scope.id, scope.target.transcript));
    return arm ? armRestart(runtime, store, scope, notice) : parkRestart(runtime, store, scope, notice);
}
/**
 * Records a pending restart for `tab` from now, for the Claude Code the check runs under, and starts its `restart`;
 * whether one started. One that cannot start leaves no request.
 */
async function armFromTab(runtime, store, scope, tab) {
    const { team, id, cwd } = scope;
    // Looked up on this rare path only: each look at a process starts a PowerShell on Windows.
    const claude = await claudeProcessOf(runtime.sessionProcesses, runtime.sessionProcesses.parentPid);
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
export async function parkedHere(store, scope) {
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
export async function armParkedRestart(runtime, store, scope, parked) {
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
export async function rearmDeadRestart(runtime, store, scope, request) {
    const { id, tab, refresh } = scope;
    if (request === undefined || restartMayAct(request, runtime.clock.now()) || request.claudeSession !== tab || !refresh.enabled || !refresh.autoRestart) {
        return false;
    }
    if ((await store.state(id))?.phase !== 'ready') {
        return false;
    }
    return armFromTab(runtime, store, scope, request);
}
