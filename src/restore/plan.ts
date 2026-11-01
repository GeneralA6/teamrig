import { dirname } from 'node:path';
import { isEffortLevel, type EffortLevel } from '../config/types.ts';
import type { PathProbe } from '../core/path-probe.ts';
import { parseObject } from '../core/jsonl.ts';
import { isRecord, stringField } from '../core/guards.ts';
import { PROMPT_MAX } from '../open/prompt.ts';
import { carryOf } from '../refresh/carry.ts';
import { runningWorkOf } from '../refresh/running.ts';
import { INTENTIONAL_END_REASONS, type RestoreEntry } from './entry.ts';
import type { ShutdownWindow } from './shutdowns.ts';
import type { TranscriptKind } from './transcript-kind.ts';

/**
 * Which recorded sessions the last shutdown killed, and how each comes back. A session is restored when it was
 * alive at the shutdown: no end recorded at all (power loss, a hard kill), or an end of no reason of its own no
 * earlier than SHUTDOWN_GRACE_MS before the last clean shutdown began (the system closing its terminal). It is
 * kept when it still runs, was active since this logon, or was reopened moments ago and has not started yet,
 * so a second run never opens it twice. Every other entry is discarded: an end the person chose, a tab closed
 * long before the shutdown, a session that is no tab (`claude -p`, background), no transcript left to resume, one
 * its transcript shows running as a background job or continued in another session, an entry older than
 * MAX_ENTRY_AGE_MS, or one that failed MAX_RESTORE_ATTEMPTS restores.
 * Nothing here reads a file or the system: the restore command gathers the facts.
 */

/** How long before the clean shutdown began an end of no reason still counts as the shutdown closing the tab. */
export const SHUTDOWN_GRACE_MS = 2 * 60_000;
export const MAX_ENTRY_AGE_MS = 14 * 24 * 60 * 60_000;
export const MAX_RESTORE_ATTEMPTS = 2;
/** A reopened tab starts Claude Code within a minute; one still not started after this counts as a failed reopen. */
export const RESTORE_IN_FLIGHT_MS = 10 * 60_000;

export type Verdict = 'restore' | 'keep' | 'discard';

export interface Judgement {
  readonly verdict: Verdict;
  readonly reason: string;
}

export interface Judged extends Judgement {
  readonly entry: RestoreEntry;
}

export interface RestorePlan {
  readonly restore: readonly Judged[];
  readonly keep: readonly Judged[];
  readonly discard: readonly Judged[];
}

/** What the restore knows of the machine when it judges the entries. */
export interface JudgeFacts {
  readonly now: number;
  /** When this logon began: an entry updated since belongs to a session that started after it. */
  readonly since: number;
  /** When the last clean shutdown ran; undefined when unknown or the machine lost power. */
  readonly shutdown: ShutdownWindow | undefined;
  /** The Claude Code sessions whose recorded process still runs Claude Code. */
  readonly running: ReadonlySet<string>;
  /** Each session's transcript where it is found now; a session missing here has none left to resume. */
  readonly transcripts: ReadonlyMap<string, string>;
  /** What each session's transcript says of where it runs now; a session missing here reads as a tab. */
  readonly kinds: ReadonlyMap<string, TranscriptKind>;
}

export function judgeEntry(entry: RestoreEntry, facts: JudgeFacts): Judgement {
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
  if (facts.shutdown !== undefined && entry.endedAt >= facts.shutdown.start - SHUTDOWN_GRACE_MS) {
    return { verdict: 'restore', reason: 'closed by the shutdown' };
  }
  return { verdict: 'discard', reason: 'closed before the shutdown' };
}

/** Every entry judged, oldest session first, so tabs reopen in the order they were first opened. */
export function selectRestorePlan(entries: readonly RestoreEntry[], facts: JudgeFacts): RestorePlan {
  const restore: Judged[] = [];
  const keep: Judged[] = [];
  const discard: Judged[] = [];
  const lists: Record<Verdict, Judged[]> = { restore, keep, discard };
  for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
    const judgement = judgeEntry(entry, facts);
    lists[judgement.verdict].push({ entry, ...judgement });
  }
  return { restore, keep, discard };
}

/** When the session's Claude Code died: its own end, else the shutdown's start, else its last event. */
export function diedAt(entry: RestoreEntry, shutdownStart: number | undefined): number {
  return entry.endedAt ?? shutdownStart ?? entry.updatedAt;
}

/** The work a session had running or scheduled when it died, which the restart took with it. */
export interface LostWork {
  /** Background commands, async helpers, monitors and workflows started and not ended. */
  readonly background: number;
  readonly crons: number;
  readonly wake: boolean;
}

/** The work the transcript shows still live at `at`; `cut` when the text is the tail of a longer file. */
export function lostWorkOf(text: string, cut: boolean, at: number): LostWork {
  const carry = carryOf(text, at, []);
  return { background: runningWorkOf(text, cut, at), crons: carry.crons.length, wake: carry.wake !== undefined };
}

function counted(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

function listed(parts: readonly string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The lost work in words (`2 background jobs, 1 cron job and a wake-up`); undefined when there is none. */
export function describeLostWork(lost: LostWork): string | undefined {
  const parts = [
    ...(lost.background > 0 ? [counted(lost.background, 'background job')] : []),
    ...(lost.crons > 0 ? [counted(lost.crons, 'cron job')] : []),
    ...(lost.wake ? ['a wake-up'] : []),
  ];
  return parts.length === 0 ? undefined : listed(parts);
}

/** `continue` resumes the session with the continue prompt; `idle` reopens it with no prompt. */
export type RestoreMode = 'continue' | 'idle';

export interface ModeChoice {
  readonly mode: RestoreMode;
  readonly why: string;
}

/**
 * How a restored session comes back: prompted to continue when it has something to resume (mid-turn, an API
 * error, work live at the shutdown) or is the lead, who hears how every other session came back; else idle.
 */
export function chooseMode(entry: RestoreEntry, lost: LostWork, isLead: boolean): ModeChoice {
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

export interface RestoredSession {
  readonly label: string;
  readonly mode: RestoreMode;
  readonly why: string;
}

/** The lead's view of a restore: `shop-web continue (mid-turn), shop-api continue (1 cron job), shop-docs idle`. */
export function summarizeRestore(sessions: readonly RestoredSession[]): string {
  return sessions.map(({ label, mode, why }) => `${label} ${mode === 'continue' ? `continue (${why})` : 'idle'}`).join(', ');
}

export const CONTINUE_PROMPT =
  'The computer restarted (update or power loss) and this session was restored automatically. ' +
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
export function continuePrompt(lost: LostWork, othersSummary: string | undefined): string {
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
export async function nearestExistingFolder(folder: string, probe: PathProbe): Promise<string | undefined> {
  for (let current = folder; ; current = dirname(current)) {
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
export function lastRecordedEffort(text: string): EffortLevel | undefined {
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
