import type { EffortLevel, RefreshConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { typedEffortsOf } from '../effort/typed-effort.ts';
import { CLAIM_END, CLAIM_HELD, CLAIM_TAKEN, isClaudeSessionId, type ClaimOutcome, type ClearMode, type PersonHold } from '../mod/clear-hand.ts';
import { endAndWait, tabProcessOf, workCutOffBy, type TabEnder } from '../open/end-tab.ts';
import { isClaudeProcess, type FeedOutcome, type ProcessInfo, type SessionProcesses } from '../open/session-processes.ts';
import type { RestoreRegistry } from '../restore/registry.ts';
import type { ClearAsks } from './clear-asks.ts';
import { readRunningWork } from './running.ts';
import type { RestartRequest } from './state.ts';
import type { RefreshStore } from './store.ts';
import { TURN_TAIL_BYTES, turnRunning } from './turn.ts';

/** Whether a new tab for the session opened, or why none did. */
export type TabOpening = { readonly kind: 'opened' } | { readonly kind: 'none'; readonly reasons: readonly string[] };

export interface RestartDeps extends TabEnder {
  readonly store: RefreshStore;
  readonly files: Files;
  /** The asks a tab's mod claims to run /clear itself, or holds while a helper runs (`mod/clear-hand.ts`). */
  readonly asks: ClearAsks;
  /** The registry of the restore after a reboot, which the ended session leaves as its SessionEnd hook would have it. */
  readonly restore: RestoreRegistry;
  /** Opens a new tab that starts the session fresh (`teamrig launch`). */
  openTab(): Promise<TabOpening>;
  /**
   * The effort level the session starts on (`launch.<id>.effort`), read from the team config at each look, as a
   * typed /effort writes it back there meanwhile; undefined when the config sets none or cannot be read.
   */
  launchEffort(): Promise<EffortLevel | undefined>;
}

export interface RestartPlan {
  readonly team: string;
  readonly id: string;
  /** The request this restart was started for: it acts on that one only, never on a later one. */
  readonly at: string;
  /** `refresh.restartDelaySeconds`: how long the session must be quiet first. */
  readonly delayMs: number;
  /** `refresh.endCommand`: run with SessionEnd's input once the session's process ended; empty for none. */
  readonly endCommand: readonly string[];
  /** Where the end command runs when the session's own folder is unknown. */
  readonly fallbackCwd: string;
  /** How the tab's mod holds the /clear for the person, which each ask carries to it. */
  readonly hold: PersonHold;
}

/** The team's `refresh.countdownSeconds` and `refresh.holdAfterActivityMinutes` as the hold an ask carries, in ms. */
export function personHoldOf(refresh: Pick<RefreshConfig, 'countdownSeconds' | 'holdAfterActivityMinutes'>): PersonHold {
  return { countdownMs: refresh.countdownSeconds * 1000, afterActivityMs: refresh.holdAfterActivityMinutes * 60_000 };
}

export type RestartResult =
  /** Nothing to do any more: the user typed, the session was refreshed by hand, its process ended, or a later request replaced this one. */
  | { readonly kind: 'cancelled'; readonly why: string }
  /** The tab's mod ran /clear, which runs Claude Code's own SessionEnd and SessionStart `clear` hooks. */
  | { readonly kind: 'cleared' }
  | { readonly kind: 'restarted'; readonly where: 'same tab' | 'new tab'; readonly endCommand: FeedOutcome | undefined }
  /** No restart: the session should be told to type /clear. */
  | { readonly kind: 'failed'; readonly why: string };

/** Lets Claude Code finish writing the turn's end before the first look at the transcript. */
export const SETTLE_MS = 3_000;
/** A session busy this long since its restart started (held by a helper included) keeps its context, and is told to type /clear. */
export const GIVE_UP_MS = 60 * 60_000;
/** How long past GIVE_UP_MS a restart may still act on its request: its last round's quiet window, ask and end. */
const LAST_ROUND_SLACK_MS = 10 * 60_000;
const POLL_MS = 500;

/**
 * The restart started for `request` may still act on it: one is pending or ending, asked less than GIVE_UP_MS and
 * its last round's slack ago. An older request was left by a restart that never finished (the machine went down
 * under it), and no restart will act on it.
 */
export function restartMayAct(request: RestartRequest | undefined, now: number): boolean {
  return request !== undefined && now - Date.parse(request.at) < GIVE_UP_MS + LAST_ROUND_SLACK_MS;
}
/** Enough of the transcript to see that a line was added. */
const QUIET_TAIL_BYTES = 4_096;
/** The user typed (the prompt hook cleared the request) or a later notice replaced it. */
const CANCELLED: RestartResult = { kind: 'cancelled', why: 'the restart was cancelled or replaced' };

/** How long the tab's mod has to claim the ask before the session is ended instead: it looks every second. */
export const CLAIM_WAIT_MS = 10_000;

/** How far up from a hook Claude Code may be: a hook run through a shell has the shell between. */
const CLAUDE_HOPS = 3;

/**
 * The Claude Code that runs `pid`: `pid` itself or one of its first parents, from one listing of every process (each
 * look starts a PowerShell on Windows, and a slow hook is killed at Claude Code's timeout); undefined when none is.
 */
export async function claudeProcessOf(processes: SessionProcesses, pid: number): Promise<number | undefined> {
  return (await processes.lineage(pid))?.slice(0, CLAUDE_HOPS).find(isClaudeProcess)?.pid;
}

/** The pending request this restart was started for; undefined once it was cancelled, taken or replaced. */
async function pendingOf(deps: RestartDeps, plan: RestartPlan): Promise<RestartRequest | undefined> {
  const request = await deps.store.restart(plan.id);
  return request?.phase === 'pending' && request.at === plan.at ? request : undefined;
}

/** `refresh.endCommand` with Claude Code's SessionEnd hook input, for the hooks the end skipped. */
async function runEndCommand(deps: RestartDeps, plan: RestartPlan, request: RestartRequest): Promise<FeedOutcome | undefined> {
  const [command, ...args] = plan.endCommand;
  if (command === undefined) {
    return undefined;
  }
  const input = JSON.stringify({
    session_id: request.claudeSession,
    transcript_path: request.transcript,
    cwd: request.cwd,
    hook_event_name: 'SessionEnd',
    reason: 'clear',
  });
  return deps.processes.feed({ command, args, cwd: request.cwd ?? plan.fallbackCwd, input });
}

/**
 * The SessionEnd hooks a hard end skips. teamrig's own restore tracker forgets the ended session, which the fresh
 * one replaces, so the restore after a reboot never reopens it beside its successor; `refresh.endCommand` then
 * stands in for any other.
 */
async function endHooks(deps: RestartDeps, plan: RestartPlan, request: RestartRequest): Promise<FeedOutcome | undefined> {
  // A registry it cannot write leaves a stale entry, which is no reason to fail a restart that happened.
  await deps.restore.remove(request.claudeSession).catch(() => undefined);
  return runEndCommand(deps, plan, request);
}

/** Whether the session's last turn has ended and none of the work it started still runs. */
async function idleAt(deps: RestartDeps, transcript: string): Promise<boolean> {
  const tail = await deps.files.readTail(transcript, TURN_TAIL_BYTES);
  return !turnRunning(tail ?? '') && (await readRunningWork(deps.files, transcript, deps.clock.now())) === 0;
}

/** What a held answer's give-up says when the tab's mod gave no reason: one older than the reason. */
export const NO_HOLD_REASON = 'its mod gave no reason';

/** What a give-up says when the tab's mod held an earlier ask of the run and answered none since. */
export const SILENT_MOD = 'its mod held an earlier ask and has answered none since';

/** What a give-up says, before the pid, when the last look at the session's running process failed. */
export const LOOKUP_FAILED = 'the system would not describe its process';

/**
 * GIVE_UP_MS after the run `started`, the session keeps its context and is told to type /clear; undefined
 * before. `last`: what kept the session from its restart at this look when it was not plain work, the tab's
 * hold of the last ask or a look at its process the system failed.
 */
async function gaveUp(deps: RestartDeps, plan: RestartPlan, started: number, last: string | undefined): Promise<RestartResult | undefined> {
  if (deps.clock.now() - started < GIVE_UP_MS) {
    return undefined;
  }
  await deps.store.clearRestart(plan.id);
  const busy = `it stayed busy for ${GIVE_UP_MS / 60_000} minutes`;
  return { kind: 'failed', why: last === undefined ? busy : `${busy} (${last})` };
}

/**
 * The session is quiet when its transcript gained nothing over one whole delay, its last turn has ended
 * (a long foreground command writes nothing while it runs) and no background work runs. It gives up
 * GIVE_UP_MS after the run `started`, however many rounds that took.
 */
async function waitForQuiet(deps: RestartDeps, plan: RestartPlan, transcript: string, started: number): Promise<RestartResult | RestartRequest> {
  await deps.sleep(Math.min(SETTLE_MS, plan.delayMs));
  let before = await deps.files.readTail(transcript, QUIET_TAIL_BYTES);
  let wait = Math.max(plan.delayMs - SETTLE_MS, POLL_MS);
  for (;;) {
    await deps.sleep(wait);
    const request = await pendingOf(deps, plan);
    if (request === undefined) {
      return CANCELLED;
    }
    if ((await deps.store.state(plan.id))?.phase !== 'ready') {
      await deps.store.clearRestart(plan.id);
      return { kind: 'cancelled', why: 'the session was refreshed another way' };
    }
    const after = await deps.files.readTail(transcript, QUIET_TAIL_BYTES);
    if (after === before && (await idleAt(deps, transcript))) {
      return request;
    }
    // Busy at work, not held: a reason an earlier round's hold gave no longer says why.
    const given = await gaveUp(deps, plan, started, undefined);
    if (given !== undefined) {
      return given;
    }
    before = after;
    wait = plan.delayMs;
  }
}

/** How a round's ask ended: the tab's answer, the request gone meanwhile, or no answer from the tab. */
type TabAnswer =
  | { readonly kind: 'cleared' }
  /** The tab claimed an `end` ask: the restart ends the session and starts it again. */
  | { readonly kind: 'end' }
  /** `why`: the mod's reason, NO_HOLD_REASON when it gave none. */
  | { readonly kind: 'held'; readonly why: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unclaimed' };

/**
 * How the tab's mod answered the ask: `held`, with its reason, while something holds the /clear; `end` when it
 * claimed an `end` ask; else it claimed it for its /clear (`cleared`).
 */
async function tabAnswerOf(deps: RestartDeps, claudeSession: string, outcome: ClaimOutcome | undefined): Promise<TabAnswer> {
  switch (outcome) {
    case CLAIM_HELD:
      return { kind: 'held', why: (await deps.asks.heldWhy(claudeSession)) ?? NO_HOLD_REASON };
    case CLAIM_END:
      return { kind: 'end' };
    default:
      return { kind: 'cleared' };
  }
}

/**
 * The level the session runs at: the newest /effort typed in it after its request (a typed command is no prompt,
 * so it leaves the request pending), else the level its last turn ran at; null when neither is known.
 */
function runningEffortOf(request: RestartRequest, tail: string): EffortLevel | null {
  const asked = Date.parse(request.at);
  return typedEffortsOf(tail, request.claudeSession).findLast((typed) => typed.at > asked)?.level ?? request.effort;
}

/**
 * How the tab refreshes the session: `end` when it runs at another effort level than the one it starts on, which a
 * /clear would keep; `clear` when the two match or either is unknown, and while a shell of the session runs, which an
 * end would take with it and a /clear keeps. The process listing comes last, as it is the slow look.
 */
async function modeOf(deps: RestartDeps, request: RestartRequest, claude: ProcessInfo, transcript: string): Promise<ClearMode> {
  const wanted = await deps.launchEffort();
  if (wanted === undefined) {
    return 'clear';
  }
  const running = runningEffortOf(request, (await deps.files.readTail(transcript, TURN_TAIL_BYTES)) ?? '');
  if (running === null || running === wanted) {
    return 'clear';
  }
  return (await workCutOffBy(deps, claude)) === undefined ? 'end' : 'clear';
}

/**
 * Asks the tab's mod to refresh the session by `mode` (`mod/clear-hand.ts`) and waits up to CLAIM_WAIT_MS for
 * its answer. `cleared` when the mod claimed it and ran /clear; `end` when it claimed an `end` ask, for the
 * restart to end the session; `held` when the mod held it: Claude Code still runs a helper of the session (or
 * would not list them), which neither a /clear nor an end may cut off, or a draft, the person or the band's
 * count holds the /clear; `unclaimed` when no mod answered: the tab has none (an older Claude Code, mods off),
 * a turn ran, or its mod stopped answering. An older mod takes an `end` ask as a /clear (`cleared`). The ask,
 * its outcome and the hold's reason are gone when this returns, so the next round asks afresh; an earlier run's
 * are removed with the new ask's posting.
 */
async function handToTab(deps: RestartDeps, plan: RestartPlan, claudeSession: string, mode: ClearMode): Promise<TabAnswer> {
  await deps.asks.post(claudeSession, { team: plan.team, id: plan.id, at: plan.at, askedAt: new Date(deps.clock.now()).toISOString(), hold: plan.hold, askEveryMs: plan.delayMs, mode });
  try {
    const deadline = deps.clock.now() + CLAIM_WAIT_MS;
    for (;;) {
      await deps.sleep(POLL_MS);
      const outcome = await deps.asks.outcome(claudeSession);
      if (outcome === CLAIM_TAKEN || outcome === CLAIM_HELD || outcome === CLAIM_END) {
        return await tabAnswerOf(deps, claudeSession, outcome);
      }
      const pending = (await pendingOf(deps, plan)) !== undefined;
      if (!pending || deps.clock.now() >= deadline) {
        // The tab's answer may land between the look and here: whoever creates the outcome first wins.
        if (!(await deps.asks.withdraw(claudeSession))) {
          return await tabAnswerOf(deps, claudeSession, await deps.asks.outcome(claudeSession));
        }
        return { kind: pending ? 'unclaimed' : 'cancelled' };
      }
    }
  } finally {
    await deps.asks.close(claudeSession);
  }
}

/**
 * Ends the session's process: in its own tab under `teamrig launch`, else after a new tab opened. Never while it
 * runs a background shell (`workCutOffBy`): that leaves the session to type /clear.
 */
async function endSession(deps: RestartDeps, plan: RestartPlan, request: RestartRequest, claude: ProcessInfo): Promise<RestartResult> {
  const cutOff = await workCutOffBy(deps, claude);
  if (cutOff !== undefined) {
    await deps.store.clearRestart(plan.id);
    return { kind: 'failed', why: cutOff };
  }
  // A second look takes a moment: a prompt typed meanwhile still cancels.
  if ((await pendingOf(deps, plan)) === undefined) {
    return CANCELLED;
  }
  await deps.store.setRestart(plan.id, { ...request, phase: 'ending' });
  if (request.supervised) {
    const problem = await endAndWait(deps, claude.pid, claude.pid);
    if (problem !== undefined) {
      await deps.store.clearRestart(plan.id);
      return { kind: 'failed', why: problem };
    }
    return { kind: 'restarted', where: 'same tab', endCommand: await endHooks(deps, plan, request) };
  }
  const opened = await deps.openTab();
  if (opened.kind === 'none') {
    await deps.store.clearRestart(plan.id);
    return { kind: 'failed', why: `no new tab opened (${opened.reasons.join('; ')})` };
  }
  const problem = await endAndWait(deps, await tabProcessOf(deps, claude), claude.pid);
  await deps.store.clearRestart(plan.id);
  if (problem !== undefined) {
    return { kind: 'failed', why: `${problem}; the fresh session runs in a new tab, so close the old one` };
  }
  return { kind: 'restarted', where: 'new tab', endCommand: await endHooks(deps, plan, request) };
}

/**
 * The automatic context refresh's restart, started hidden by the Stop hook once the session's handover is
 * written (`refresh.autoRestart`). It waits until the session has been quiet for the whole delay, with its
 * last turn ended and no background work, and acts only while its request is still pending (a prompt the user types cancels it)
 * and the session still waits for a fresh start. Then it checks the process is Claude Code (a process that
 * still runs but which the system would not describe is looked at again after the next quiet window) and:
 * - first asks the tab's mod to run /clear (`handToTab`). The /clear keeps the tab and its process, and
 *   Claude Code runs its own SessionEnd and SessionStart `clear` hooks, so no end command is needed. When the
 *   session runs at another effort level than its config's (`modeOf`), which a /clear keeps, the ask is in
 *   `end` mode instead: once the mod claims it under the same holds, the session is ended as below and starts
 *   again at the config's level;
 * - when the mod holds the ask (Claude Code says a helper of the session is still live, or would not list
 *   them; or a draft, the person or the band's count holds the /clear), counts the session as busy: it ends
 *   nothing, waits for quiet and asks again, until GIVE_UP_MS, whose why then names the mod's last reason;
 * - when no mod answers an ask after the tab's mod held an earlier one of this run, counts the session as held
 *   too: the silence says nothing of the person (it held for them before), so it ends nothing and asks again
 *   until GIVE_UP_MS, whose why then says the mod went silent;
 * - when no mod claims the ask and the session is still idle, ends the process, unless it still runs a
 *   background shell, which the end would take too: then the session is told to type /clear. Under `teamrig launch`
 *   (supervised) it marks the request `ending`, and launch starts Claude Code again in the same tab once
 *   it has gone. Otherwise it first opens a new tab that starts the session fresh, and only once that
 *   opened ends the old one with its tab; when no tab opens, nothing is ended. Either way it then runs
 *   `refresh.endCommand`. The fresh start reads the handover (SessionStart `startup`);
 * - when a turn ran meanwhile, waits for the session to be quiet again and asks again.
 */
export async function runRestart(deps: RestartDeps, plan: RestartPlan): Promise<RestartResult> {
  const armed = await pendingOf(deps, plan);
  if (armed === undefined) {
    return { kind: 'cancelled', why: 'no restart is pending' };
  }
  if (armed.transcript === null) {
    await deps.store.clearRestart(plan.id);
    return { kind: 'failed', why: 'its transcript is unknown, so teamrig cannot tell when it is idle' };
  }
  const transcript = armed.transcript;
  const started = deps.clock.now();
  /** The tab's mod held an ask of this run: the tab has a mod, so a later silence is no leave to end it. */
  let modHeld = false;
  for (;;) {
    const quiet = await waitForQuiet(deps, plan, transcript, started);
    if ('kind' in quiet) {
      return quiet;
    }
    const request = quiet;
    const claude = await deps.processes.describe(request.pid);
    if (claude === undefined) {
      if (!deps.processes.alive(request.pid)) {
        await deps.store.clearRestart(plan.id);
        return { kind: 'cancelled', why: 'its Claude Code has already ended' };
      }
      // It runs, but the system would not describe it (a lookup that failed or timed out): look again after the next quiet window.
      const given = await gaveUp(deps, plan, started, `${LOOKUP_FAILED} ${request.pid}`);
      if (given !== undefined) {
        return given;
      }
      continue;
    }
    if (!isClaudeProcess(claude)) {
      await deps.store.clearRestart(plan.id);
      return { kind: 'failed', why: `process ${claude.pid} is ${claude.name}, not Claude Code` };
    }
    // That look takes a moment: a prompt typed meanwhile still cancels.
    if ((await pendingOf(deps, plan)) === undefined) {
      return CANCELLED;
    }
    if (!isClaudeSessionId(request.claudeSession)) {
      return endSession(deps, plan, request, claude);
    }
    const answer = await handToTab(deps, plan, request.claudeSession, await modeOf(deps, request, claude, transcript));
    switch (answer.kind) {
      case 'cleared':
        // The claim clears the request; this clears it only when the claim stopped before that.
        if ((await pendingOf(deps, plan)) !== undefined) {
          await deps.store.clearRestart(plan.id);
        }
        return { kind: 'cleared' };
      case 'end':
        // The end claim leaves the request pending, so a prompt typed since still cancels the end.
        return endSession(deps, plan, request, claude);
      case 'cancelled':
        return CANCELLED;
      case 'held': {
        // A helper may still run, which the transcript may not show: busy, never ended, however idle the transcript looks.
        modHeld = true;
        const given = await gaveUp(deps, plan, started, `its tab last held the /clear: ${answer.why}`);
        if (given !== undefined) {
          return given;
        }
        continue;
      }
      case 'unclaimed': {
        if (!modHeld) {
          break;
        }
        // A mod that held for the person and then fell silent (as one after a /reload-plugins did, T2544) no longer
        // sees their draft or keys: an end now could land under their typing.
        const given = await gaveUp(deps, plan, started, SILENT_MOD);
        if (given !== undefined) {
          return given;
        }
        continue;
      }
    }
    if (!(await idleAt(deps, transcript))) {
      continue;
    }
    if ((await pendingOf(deps, plan)) === undefined) {
      return CANCELLED;
    }
    return endSession(deps, plan, request, claude);
  }
}
