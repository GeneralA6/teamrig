import type { Files } from '../core/files.ts';
import type { Clock, Sleep } from '../core/lock.ts';
import { CLAIM_HELD, CLAIM_TAKEN, isClaudeSessionId, type ClaimOutcome } from '../mod/clear-hand.ts';
import type { FeedOutcome, ProcessInfo, SessionProcesses } from '../open/session-processes.ts';
import type { ClearAsks } from './clear-asks.ts';
import { readRunningWork } from './running.ts';
import type { RestartRequest } from './state.ts';
import type { RefreshStore } from './store.ts';
import { TURN_TAIL_BYTES, turnRunning } from './turn.ts';

/** Whether a new tab for the session opened, or why none did. */
export type TabOpening = { readonly kind: 'opened' } | { readonly kind: 'none'; readonly reasons: readonly string[] };

export interface RestartDeps {
  readonly store: RefreshStore;
  readonly files: Files;
  readonly processes: SessionProcesses;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly platform: NodeJS.Platform;
  /** The asks a tab's mod claims to run /clear itself, or holds while a helper runs (`mod/clear-hand.ts`). */
  readonly asks: ClearAsks;
  /** Opens a new tab that starts the session fresh (`teamrig launch`). */
  openTab(): Promise<TabOpening>;
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
/** How long an ended process may take to go. */
export const END_WAIT_MS = 10_000;
const POLL_MS = 500;
/** Enough of the transcript to see that a line was added. */
const QUIET_TAIL_BYTES = 4_096;
/** The program Claude Code runs as: its own binary, or Node.js running its script. */
const CLAUDE_PROGRAM = /^claude(\.exe)?$/i;
const NODE_PROGRAM = /^node(\.exe)?$/i;
/** A shell a tab runs Claude Code in, as a tab reopened by `powershell -NoExit -Command claude --resume ...`. */
const TAB_SHELL = /^(powershell|pwsh|cmd)(\.exe)?$/i;
/**
 * A shell Claude Code runs a command in (Bash, PowerShell, a Monitor's); a login shell's name starts with a dash.
 * Not cmd: an MCP server started through `cmd /c` runs as long as the session and ends with it anyway.
 */
const COMMAND_SHELL = /^-?(bash|sh|dash|zsh|fish|ksh|powershell|pwsh)(\.exe)?$/i;
/** A shell under Claude Code counts only when it is still there this much later: a status line command runs for moments. */
export const SHELL_RECHECK_MS = 2_000;

function isClaude(info: ProcessInfo): boolean {
  return CLAUDE_PROGRAM.test(info.name) || (NODE_PROGRAM.test(info.name) && /claude/i.test(info.commandLine));
}

/** The user typed (the prompt hook cleared the request) or a later notice replaced it. */
const CANCELLED: RestartResult = { kind: 'cancelled', why: 'the restart was cancelled or replaced' };

/** How long the tab's mod has to claim the ask before the session is ended instead: it looks every second. */
export const CLAIM_WAIT_MS = 10_000;

/** How far up from a hook Claude Code may be: a hook run through a shell has the shell between. */
const CLAUDE_HOPS = 3;

/** The Claude Code that runs `pid`: `pid` itself or one of its first parents; undefined when none is. */
export async function claudeProcessOf(processes: SessionProcesses, pid: number): Promise<number | undefined> {
  let next = pid;
  for (let hop = 0; hop < CLAUDE_HOPS; hop += 1) {
    const info = await processes.describe(next);
    if (info === undefined) {
      return undefined;
    }
    if (isClaude(info)) {
      return info.pid;
    }
    next = info.parentPid;
  }
  return undefined;
}

/** The pending request this restart was started for; undefined once it was cancelled, taken or replaced. */
async function pendingOf(deps: RestartDeps, plan: RestartPlan): Promise<RestartRequest | undefined> {
  const request = await deps.store.restart(plan.id);
  return request?.phase === 'pending' && request.at === plan.at ? request : undefined;
}

/** Whether `pid` is gone within `ms`, looking every `POLL_MS`. */
async function goneWithin(deps: RestartDeps, pid: number, ms: number): Promise<boolean> {
  const deadline = deps.clock.now() + ms;
  while (deps.processes.alive(pid)) {
    if (deps.clock.now() >= deadline) {
      return false;
    }
    await deps.sleep(POLL_MS);
  }
  return true;
}

/** Ends `target`, then forces it if `watched` outlives the wait; why it failed, or undefined once `watched` is gone. */
async function endAndWait(deps: RestartDeps, target: number, watched: number): Promise<string | undefined> {
  for (const how of ['ask', 'force'] as const) {
    const ended = await deps.processes.end(target, how);
    if (ended.kind === 'failed') {
      return `could not end process ${target}: ${ended.error}`;
    }
    if (await goneWithin(deps, watched, END_WAIT_MS)) {
      return undefined;
    }
  }
  return `process ${watched} still runs after it was ended`;
}

/**
 * The process to end so the old tab closes: on Windows, the shell the tab runs Claude Code in (ending it
 * ends Claude Code too); otherwise Claude Code itself, and its tab stays open at a prompt.
 */
async function tabProcessOf(deps: RestartDeps, claude: ProcessInfo): Promise<number> {
  if (deps.platform !== 'win32') {
    return claude.pid;
  }
  const parent = await deps.processes.describe(claude.parentPid);
  return parent !== undefined && TAB_SHELL.test(parent.name) && /claude/i.test(parent.commandLine) ? parent.pid : claude.pid;
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

/** Whether the session's last turn has ended and none of the work it started still runs. */
async function idleAt(deps: RestartDeps, transcript: string): Promise<boolean> {
  const tail = await deps.files.readTail(transcript, TURN_TAIL_BYTES);
  return !turnRunning(tail ?? '') && (await readRunningWork(deps.files, transcript, deps.clock.now())) === 0;
}

/** GIVE_UP_MS after the run `started`, the session keeps its context and is told to type /clear; undefined before. */
async function gaveUp(deps: RestartDeps, plan: RestartPlan, started: number): Promise<RestartResult | undefined> {
  if (deps.clock.now() - started < GIVE_UP_MS) {
    return undefined;
  }
  await deps.store.clearRestart(plan.id);
  return { kind: 'failed', why: `it stayed busy for ${GIVE_UP_MS / 60_000} minutes` };
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
    const given = await gaveUp(deps, plan, started);
    if (given !== undefined) {
      return given;
    }
    before = after;
    wait = plan.delayMs;
  }
}

/** How the tab's mod answered the ask: `held` while the session still runs a helper, else it claimed it (`cleared`). */
function tabAnswerOf(outcome: ClaimOutcome | undefined): 'cleared' | 'held' {
  return outcome === CLAIM_HELD ? 'held' : 'cleared';
}

/**
 * Asks the tab's mod to run /clear (`mod/clear-hand.ts`) and waits up to CLAIM_WAIT_MS for its answer.
 * `cleared` when the mod claimed it and ran /clear; `held` when the mod held it because Claude Code still
 * runs a helper of the session (or would not list them), which neither a /clear nor an end may cut off;
 * `unclaimed` when no mod answered: the tab has none (an older Claude Code, mods off) or a turn ran. The
 * ask and its outcome are gone when this returns, so the next round asks afresh; an earlier run's outcome
 * is removed with the new ask's posting.
 */
async function handToTab(deps: RestartDeps, plan: RestartPlan, claudeSession: string): Promise<'cleared' | 'held' | 'cancelled' | 'unclaimed'> {
  await deps.asks.post(claudeSession, { team: plan.team, id: plan.id, at: plan.at, askedAt: new Date(deps.clock.now()).toISOString() });
  try {
    const deadline = deps.clock.now() + CLAIM_WAIT_MS;
    for (;;) {
      await deps.sleep(POLL_MS);
      const outcome = await deps.asks.outcome(claudeSession);
      if (outcome === CLAIM_TAKEN || outcome === CLAIM_HELD) {
        return tabAnswerOf(outcome);
      }
      const pending = (await pendingOf(deps, plan)) !== undefined;
      if (!pending || deps.clock.now() >= deadline) {
        // The tab's answer may land between the look and here: whoever creates the outcome first wins.
        if (!(await deps.asks.withdraw(claudeSession))) {
          return tabAnswerOf(await deps.asks.outcome(claudeSession));
        }
        return pending ? 'unclaimed' : 'cancelled';
      }
    }
  } finally {
    await deps.asks.close(claudeSession);
  }
}

/** The command shells `pid` runs; undefined when the system would not tell. */
async function shellsUnder(deps: RestartDeps, pid: number): Promise<readonly ProcessInfo[] | undefined> {
  return (await deps.processes.children(pid))?.filter((info) => COMMAND_SHELL.test(info.name));
}

/**
 * Why ending `claude` would cut off work it runs, or undefined when it would not. An end takes every process
 * it started, so a shell still there on two looks `SHELL_RECHECK_MS` apart (a background command, a Monitor)
 * would die with it, as would one the transcript's running work (`running.ts`) no longer shows: that reads
 * only the transcript's end and the last hours. A process list the system would not give counts as unsafe.
 * A /clear needs no such look: it keeps the background shells.
 */
async function workCutOffBy(deps: RestartDeps, claude: ProcessInfo): Promise<string | undefined> {
  const unknown = `teamrig could not list what its Claude Code (${claude.pid}) runs`;
  const seen = await shellsUnder(deps, claude.pid);
  if (seen === undefined) {
    return unknown;
  }
  if (seen.length === 0) {
    return undefined;
  }
  await deps.sleep(SHELL_RECHECK_MS);
  const again = await shellsUnder(deps, claude.pid);
  if (again === undefined) {
    return unknown;
  }
  const lasting = again.filter((shell) => seen.some((first) => first.pid === shell.pid));
  return lasting.length === 0 ? undefined : `ending its Claude Code would also end the background shells it runs (pid ${lasting.map((shell) => shell.pid).join(', ')})`;
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
    return { kind: 'restarted', where: 'same tab', endCommand: await runEndCommand(deps, plan, request) };
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
  return { kind: 'restarted', where: 'new tab', endCommand: await runEndCommand(deps, plan, request) };
}

/**
 * The automatic context refresh's restart, started hidden by the Stop hook once the session's handover is
 * written (`refresh.autoRestart`). It waits until the session has been quiet for the whole delay, with its
 * last turn ended and no background work, and acts only while its request is still pending (a prompt the user types cancels it)
 * and the session still waits for a fresh start. Then it checks the process is Claude Code and:
 * - first asks the tab's mod to run /clear (`handToTab`). The /clear keeps the tab and its process, and
 *   Claude Code runs its own SessionEnd and SessionStart `clear` hooks, so no end command is needed;
 * - when the mod holds the ask (Claude Code says a helper of the session is still live, or would not list
 *   them), counts the session as busy: it ends nothing, waits for quiet and asks again, until GIVE_UP_MS;
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
  for (;;) {
    const quiet = await waitForQuiet(deps, plan, transcript, started);
    if ('kind' in quiet) {
      return quiet;
    }
    const request = quiet;
    const claude = await deps.processes.describe(request.pid);
    if (claude === undefined) {
      await deps.store.clearRestart(plan.id);
      return { kind: 'cancelled', why: 'its Claude Code has already ended' };
    }
    if (!isClaude(claude)) {
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
    switch (await handToTab(deps, plan, request.claudeSession)) {
      case 'cleared':
        // The claim clears the request; this clears it only when the claim stopped before that.
        if ((await pendingOf(deps, plan)) !== undefined) {
          await deps.store.clearRestart(plan.id);
        }
        return { kind: 'cleared' };
      case 'cancelled':
        return CANCELLED;
      case 'held': {
        // A helper still runs, which the transcript may not show: busy, never ended, however idle the transcript looks.
        const given = await gaveUp(deps, plan, started);
        if (given !== undefined) {
          return given;
        }
        continue;
      }
      case 'unclaimed':
        break;
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
