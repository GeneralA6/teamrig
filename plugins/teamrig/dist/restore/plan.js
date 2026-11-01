import { dirname } from 'node:path';
import { isEffortLevel } from "../config/types.js";
import { parseObject } from "../core/jsonl.js";
import { isRecord, stringField } from "../core/guards.js";
import { PROMPT_MAX } from "../open/prompt.js";
import { carryOf } from "../refresh/carry.js";
import { runningWorkOf } from "../refresh/running.js";
import { INTENTIONAL_END_REASONS } from "./entry.js";
/**
 * Which recorded sessions the last shutdown killed, and how each comes back. A session is restored when it was
 * alive at the shutdown: no end recorded at all (power loss, a hard kill), or an end of no reason of its own within
 * the last clean shutdown's span, from SHUTDOWN_GRACE_MS before it began to the moment the event log stopped (the
 * system closing its terminal). A tab closed at another time with no reason of its own is restored when it closed
 * mid-turn or on an API error; else it is `closed`: kept CLOSED_KEEP_MS and offered apart, never reopened unasked
 * and never lost (11-01, T1747). The verdict reads only the entry and that span, so a reboot after the restore
 * never turns a kept entry into a discarded one (T1737). An entry is kept when it still runs, was active since this
 * logon, or was reopened moments ago and has not started yet, so a second run never opens it twice. Every other
 * entry is discarded: an end the person chose, a session that is no tab (`claude -p`, background), no transcript
 * left to resume, one its transcript shows running as a background job or continued in another session, a closed
 * tab past CLOSED_KEEP_MS, an entry older than MAX_ENTRY_AGE_MS, or one that failed MAX_RESTORE_ATTEMPTS restores.
 * Nothing here reads a file or the system: the restore command gathers the facts.
 */
/** How long before the clean shutdown began an end of no reason still counts as the shutdown closing the tab. */
export const SHUTDOWN_GRACE_MS = 2 * 60_000;
export const MAX_ENTRY_AGE_MS = 14 * 24 * 60 * 60_000;
export const MAX_RESTORE_ATTEMPTS = 2;
/** A reopened tab starts Claude Code within a minute; one still not started after this counts as a failed reopen. */
export const RESTORE_IN_FLIGHT_MS = 10 * 60_000;
/** How long a tab closed outside a shutdown, with no reason of its own, stays on offer before it is discarded. */
export const CLOSED_KEEP_MS = 48 * 60 * 60_000;
export function judgeEntry(entry, facts) {
    if (entry.entrypoint !== undefined && entry.entrypoint !== 'cli') {
        return { verdict: 'discard', reason: `not a terminal session (${entry.entrypoint})` };
    }
    if (entry.sessionKind === 'bg') {
        return { verdict: 'discard', reason: 'background session' };
    }
    if (entry.restoredAt !== undefined && entry.restoredAt >= entry.updatedAt && facts.now - entry.restoredAt < RESTORE_IN_FLIGHT_MS) {
        return { verdict: 'keep', reason: 'reopened, not started yet' };
    }
    if (entry.restoreAttempts >= MAX_RESTORE_ATTEMPTS) {
        return { verdict: 'discard', reason: 'restore failed repeatedly' };
    }
    if (facts.now - entry.updatedAt > MAX_ENTRY_AGE_MS) {
        return { verdict: 'discard', reason: 'stale' };
    }
    if (entry.updatedAt >= facts.since) {
        return { verdict: 'keep', reason: 'active since logon' };
    }
    if (facts.running.has(entry.claudeSession)) {
        return { verdict: 'keep', reason: 'still running' };
    }
    // `claude --resume` needs the transcript; a session that never got a first prompt has none.
    if (!facts.transcripts.has(entry.claudeSession)) {
        return { verdict: 'discard', reason: 'no transcript' };
    }
    // A job's hooks may not see its session kind, and a tab sent to a job never records an end: its transcript tells.
    const kind = facts.kinds.get(entry.claudeSession);
    if (kind?.background === true) {
        return { verdict: 'discard', reason: 'background session' };
    }
    if (kind?.continuedIn !== undefined) {
        return { verdict: 'discard', reason: `continued in ${kind.continuedIn.slice(0, 8)}` };
    }
    if (entry.endedAt === undefined) {
        return { verdict: 'restore', reason: 'killed without exiting' };
    }
    if (entry.endReason !== undefined && INTENTIONAL_END_REASONS.has(entry.endReason)) {
        return { verdict: 'discard', reason: `exited (${entry.endReason})` };
    }
    const { shutdown } = facts;
    if (shutdown !== undefined && entry.endedAt >= shutdown.start - SHUTDOWN_GRACE_MS && entry.endedAt <= shutdown.end) {
        return { verdict: 'restore', reason: 'closed by the shutdown' };
    }
    if (facts.now - entry.endedAt > CLOSED_KEEP_MS) {
        return { verdict: 'discard', reason: `closed more than ${CLOSED_KEEP_MS / 3_600_000} h ago` };
    }
    if (entry.state === 'working') {
        return { verdict: 'restore', reason: 'closed mid-turn' };
    }
    if (entry.state === 'error') {
        return { verdict: 'restore', reason: 'closed on an API error' };
    }
    return { verdict: 'closed', reason: shutdown === undefined ? 'closed, no shutdown on record' : 'closed outside a shutdown' };
}
/** Every entry judged, oldest session first, so tabs reopen in the order they were first opened. */
export function selectRestorePlan(entries, facts) {
    const restore = [];
    const closed = [];
    const keep = [];
    const discard = [];
    const lists = { restore, closed, keep, discard };
    for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
        const judgement = judgeEntry(entry, facts);
        lists[judgement.verdict].push({ entry, ...judgement });
    }
    return { restore, closed, keep, discard };
}
/** When the session's Claude Code died: its own end, else the shutdown's start, else its last event. */
export function diedAt(entry, shutdownStart) {
    return entry.endedAt ?? shutdownStart ?? entry.updatedAt;
}
/** The work the transcript shows still live at `at`; `cut` when the text is the tail of a longer file. */
export function lostWorkOf(text, cut, at) {
    const carry = carryOf(text, at, []);
    return { background: runningWorkOf(text, cut, at), crons: carry.crons.length, wake: carry.wake !== undefined };
}
function counted(count, one) {
    return `${count} ${one}${count === 1 ? '' : 's'}`;
}
function listed(parts) {
    return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
/** The lost work in words (`2 background jobs, 1 cron job and a wake-up`); undefined when there is none. */
export function describeLostWork(lost) {
    const parts = [
        ...(lost.background > 0 ? [counted(lost.background, 'background job')] : []),
        ...(lost.crons > 0 ? [counted(lost.crons, 'cron job')] : []),
        ...(lost.wake ? ['a wake-up'] : []),
    ];
    return parts.length === 0 ? undefined : listed(parts);
}
/**
 * How a restored session comes back: prompted to continue when it has something to resume (mid-turn, an API
 * error, work live at the shutdown) or is the lead, who hears how every other session came back; else idle.
 */
export function chooseMode(entry, lost, isLead) {
    const lostWords = describeLostWork(lost);
    const why = [
        ...(entry.state === 'working' ? ['mid-turn'] : []),
        ...(entry.state === 'error' ? ['api error'] : []),
        ...(lostWords === undefined ? [] : [lostWords]),
    ];
    if (why.length > 0) {
        return { mode: 'continue', why: why.join(' and ') };
    }
    return isLead ? { mode: 'continue', why: 'lead' } : { mode: 'idle', why: 'nothing live' };
}
/** The lead's view of a restore: `shop-web continue (mid-turn), shop-api continue (1 cron job), shop-docs idle`. */
export function summarizeRestore(sessions) {
    return sessions.map(({ label, mode, why }) => `${label} ${mode === 'continue' ? `continue (${why})` : 'idle'}`).join(', ');
}
export const CONTINUE_PROMPT = 'The computer restarted (update or power loss) and this session was restored automatically. ' +
    'If your last task was already finished, or you were told to pause or stay idle, just reply in one line and wait. ' +
    'If you were waiting for my decision or permission, ask again instead of proceeding. ' +
    'Otherwise, before doing anything, re-check the current state: services, containers, port-forwards and builds ' +
    'may still be starting, the last step you ran may or may not have completed, and background jobs, monitors, ' +
    'loops and scheduled wake-ups from before the restart are gone. ' +
    'Then continue the task you were working on from where you left off, restarting any background work it still needs.';
const ELLIPSIS = '...';
/**
 * The first prompt of a session restored to continue: CONTINUE_PROMPT, the work it lost, and for the lead how
 * every other session came back, cut so the whole stays within PROMPT_MAX.
 */
export function continuePrompt(lost, othersSummary) {
    const lostWords = describeLostWork(lost);
    const base = lostWords === undefined ? CONTINUE_PROMPT : `${CONTINUE_PROMPT} At the shutdown you had ${lostWords} live.`;
    if (othersSummary === undefined || othersSummary === '') {
        return base;
    }
    const lead = `${base} Other sessions restored: `;
    const room = PROMPT_MAX - lead.length - 1;
    const summary = othersSummary.length <= room ? othersSummary : `${othersSummary.slice(0, Math.max(0, room - ELLIPSIS.length))}${ELLIPSIS}`;
    return `${lead}${summary}.`;
}
/**
 * The folder to reopen a session in: its own, or its nearest existing parent when that is gone (a removed git
 * worktree, most often). A terminal fails the whole tab on a missing folder, and Claude Code resumes a session
 * whose folder is gone in the current one, so the closest surviving parent is the best stand-in.
 */
export async function nearestExistingFolder(folder, probe) {
    for (let current = folder;; current = dirname(current)) {
        if ((await probe.kind(current)) === 'folder') {
            return current;
        }
        if (dirname(current) === current) {
            return undefined;
        }
    }
}
const ASSISTANT_TURN = '"type":"assistant"';
/**
 * The effort the session last ran at: the newest real assistant turn that records one. `claude --resume` alone
 * reopens at the configured default and drops an effort set inside the session (`/effort`). The model is not
 * carried: the transcript records it without its context-window suffix, so passing it would reopen on a smaller
 * window. Undefined when no turn records a known level.
 */
export function lastRecordedEffort(text) {
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? '';
        // Most lines are not assistant turns; a torn first line of a tail fails to parse and is skipped.
        const turn = line.includes(ASSISTANT_TURN) ? parseObject(line) : undefined;
        if (turn === undefined || turn['type'] !== 'assistant') {
            continue;
        }
        const message = turn['message'];
        if (isRecord(message) && stringField(message, 'model') === '<synthetic>') {
            continue;
        }
        const effort = turn['effort'];
        if (isEffortLevel(effort)) {
            return effort;
        }
    }
    return undefined;
}
