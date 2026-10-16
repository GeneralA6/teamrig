import { readRunningWork } from "./running.js";
/** Lets Claude Code finish writing the turn's end before the first look at the transcript. */
export const SETTLE_MS = 3_000;
/** A session busy this long keeps its context, and is told to type /clear. */
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
function isClaude(info) {
    return CLAUDE_PROGRAM.test(info.name) || (NODE_PROGRAM.test(info.name) && /claude/i.test(info.commandLine));
}
/** The user typed (the prompt hook cleared the request) or a later notice replaced it. */
const CANCELLED = { kind: 'cancelled', why: 'the restart was cancelled or replaced' };
/** How far up from a hook Claude Code may be: a hook run through a shell has the shell between. */
const CLAUDE_HOPS = 3;
/** The Claude Code that runs `pid`: `pid` itself or one of its first parents; undefined when none is. */
export async function claudeProcessOf(processes, pid) {
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
async function pendingOf(deps, plan) {
    const request = await deps.store.restart(plan.id);
    return request?.phase === 'pending' && request.at === plan.at ? request : undefined;
}
/** Whether `pid` is gone within `ms`, looking every `POLL_MS`. */
async function goneWithin(deps, pid, ms) {
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
async function endAndWait(deps, target, watched) {
    for (const how of ['ask', 'force']) {
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
async function tabProcessOf(deps, claude) {
    if (deps.platform !== 'win32') {
        return claude.pid;
    }
    const parent = await deps.processes.describe(claude.parentPid);
    return parent !== undefined && TAB_SHELL.test(parent.name) && /claude/i.test(parent.commandLine) ? parent.pid : claude.pid;
}
/** `refresh.endCommand` with Claude Code's SessionEnd hook input, for the hooks the end skipped. */
async function runEndCommand(deps, plan, request) {
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
/** The session is quiet when its transcript gained nothing over one whole delay and no background work runs. */
async function waitForQuiet(deps, plan, transcript) {
    const started = deps.clock.now();
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
        if (after === before && (await readRunningWork(deps.files, transcript, deps.clock.now())) === 0) {
            return request;
        }
        if (deps.clock.now() - started >= GIVE_UP_MS) {
            await deps.store.clearRestart(plan.id);
            return { kind: 'failed', why: `it stayed busy for ${GIVE_UP_MS / 60_000} minutes` };
        }
        before = after;
        wait = plan.delayMs;
    }
}
/**
 * The automatic context refresh's restart, started hidden by the Stop hook once the session's handover is
 * written (`refresh.autoRestart`). It waits until the session has been quiet for the whole delay with no
 * background work, and acts only while its request is still pending (a prompt the user types cancels it)
 * and the session still waits for a fresh start. Then it checks the process is Claude Code and ends it:
 * - Under `teamrig launch` (supervised), it marks the request `ending`, and launch starts Claude Code
 *   again in the same tab once it has gone.
 * - Otherwise it first opens a new tab that starts the session fresh, and only once that opened ends the
 *   old one with its tab; when no tab opens, nothing is ended.
 * Either way it then runs `refresh.endCommand`. The fresh start reads the handover (SessionStart `startup`).
 */
export async function runRestart(deps, plan) {
    const armed = await pendingOf(deps, plan);
    if (armed === undefined) {
        return { kind: 'cancelled', why: 'no restart is pending' };
    }
    if (armed.transcript === null) {
        await deps.store.clearRestart(plan.id);
        return { kind: 'failed', why: 'its transcript is unknown, so teamrig cannot tell when it is idle' };
    }
    const quiet = await waitForQuiet(deps, plan, armed.transcript);
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
