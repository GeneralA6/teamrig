import { basename, join } from 'node:path';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { parseObject } from '../core/jsonl.ts';
import type { Files } from '../core/files.ts';
import { CLAUDE_SESSION_ID } from '../inbox/marks.ts';

/**
 * Status line snapshots: what Claude Code's status line input says about one session, saved as
 * `<snapshot folder>/<Claude session id>.json` so `teamrig budget` can read the plan's own use of the
 * week. `teamrig statusline` writes them; any other status line may write the same format ("bring your
 * own status line"). The format, one JSON object, its keys in snake_case:
 *
 * - `ts`: when it was written, ISO 8601 UTC;
 * - `session_id`: the Claude Code session id, also the file name;
 * - `cwd`: the session's folder;
 * - `agent_name`, `model`: the agent's name and the model's display name, or null;
 * - `rate_limits`: null, or `{ five_hour, seven_day }`, each null or absent, or
 *   `{ used_percentage, resets_at }` (percent used, and the reset in epoch seconds);
 * - `rate_limits_since`: when the session's snapshots began to show these rate limits, ISO 8601 UTC, so
 *   the reading was taken by then; null or absent: by `ts`;
 * - `rate_limits_after`: when the session's snapshot last showed other rate limits, ISO 8601 UTC, so the
 *   reading was taken after it; null or absent when unknown;
 * - `cost_usd`, `context_used_pct`, `context_input_tokens`: numbers, or null.
 *
 * Claude Code sends `rate_limits` only to a claude.ai plan's sessions, after the session's first reply,
 * and redraws the status line with the session's last reading until its next reply: a snapshot written
 * now may hold a reading days old. The two times date the reading itself.
 */

/** One rate-limit window: percent used and when it resets, in epoch milliseconds. */
export interface RateWindow {
  readonly usedPct: number;
  readonly resetsAt: number;
}

export interface RateLimits {
  readonly fiveHour: RateWindow | null;
  readonly sevenDay: RateWindow | null;
}

export interface StatusSnapshot {
  readonly ts: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly agentName: string | null;
  readonly model: string | null;
  readonly rateLimits: RateLimits | null;
  /** When the session's snapshots began to show `rateLimits`: the reading was taken by then; null: by `ts`. */
  readonly rateLimitsSince: string | null;
  /** When the session's snapshot last showed other rate limits: the reading was taken after it; null when unknown. */
  readonly rateLimitsAfter: string | null;
  readonly costUsd: number | null;
  readonly contextUsedPct: number | null;
  readonly contextInputTokens: number | null;
}

const MS_PER_SECOND = 1000;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** A window in the stored or Claude Code shape: `used_percentage` and `resets_at` in epoch seconds. */
function rateWindowOf(value: unknown): RateWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  const usedPct = finite(value['used_percentage']);
  const resetsAt = finite(value['resets_at']);
  return usedPct === null || resetsAt === null ? null : { usedPct, resetsAt: resetsAt * MS_PER_SECOND };
}

function rateLimitsOf(value: unknown): RateLimits | null {
  if (!isRecord(value)) {
    return null;
  }
  const fiveHour = rateWindowOf(value['five_hour']);
  const sevenDay = rateWindowOf(value['seven_day']);
  return fiveHour === null && sevenDay === null ? null : { fiveHour, sevenDay };
}

/** The Claude Code session id of a status input: `session_id`, else the transcript's file name. */
function sessionIdOf(status: JsonRecord): string | undefined {
  const transcript = stringField(status, 'transcript_path');
  const id = stringField(status, 'session_id') ?? (transcript === undefined ? undefined : basename(transcript, '.jsonl'));
  return id !== undefined && CLAUDE_SESSION_ID.test(id) ? id : undefined;
}

/**
 * The snapshot of Claude Code's status line input (its JSON on stdin), taken at `now`; undefined when
 * the input is not a JSON object or names no valid session id, which also keeps the file name safe.
 */
export function snapshotOfStatus(input: string, now: number): StatusSnapshot | undefined {
  const status = parseObject(input.trim());
  const sessionId = status === undefined ? undefined : sessionIdOf(status);
  if (status === undefined || sessionId === undefined) {
    return undefined;
  }
  const workspace = recordField(status, 'workspace');
  const context = recordField(status, 'context_window');
  const ts = new Date(now).toISOString();
  const rateLimits = rateLimitsOf(status['rate_limits']);
  return {
    ts,
    sessionId,
    cwd: (workspace === undefined ? undefined : stringField(workspace, 'current_dir')) ?? stringField(status, 'cwd') ?? '',
    agentName: textOrNull(recordField(status, 'agent')?.['name']),
    model: textOrNull(recordField(status, 'model')?.['display_name']),
    rateLimits,
    rateLimitsSince: rateLimits === null ? null : ts,
    rateLimitsAfter: null,
    costUsd: finite(recordField(status, 'cost')?.['total_cost_usd']),
    contextUsedPct: finite(context?.['used_percentage']),
    contextInputTokens: finite(context?.['total_input_tokens']),
  };
}

function storedWindow(window: RateWindow | null): JsonRecord | null {
  return window === null ? null : { used_percentage: window.usedPct, resets_at: Math.round(window.resetsAt / MS_PER_SECOND) };
}

/** The snapshot as its file's text. */
export function formatSnapshot(snapshot: StatusSnapshot): string {
  const limits = snapshot.rateLimits;
  return JSON.stringify({
    ts: snapshot.ts,
    session_id: snapshot.sessionId,
    cwd: snapshot.cwd,
    agent_name: snapshot.agentName,
    model: snapshot.model,
    rate_limits: limits === null ? null : { five_hour: storedWindow(limits.fiveHour), seven_day: storedWindow(limits.sevenDay) },
    rate_limits_since: snapshot.rateLimitsSince,
    rate_limits_after: snapshot.rateLimitsAfter,
    cost_usd: snapshot.costUsd,
    context_used_pct: snapshot.contextUsedPct,
    context_input_tokens: snapshot.contextInputTokens,
  });
}

/** A snapshot file's text; undefined when it is damaged or lacks its time or session id. */
export function parseSnapshot(text: string): StatusSnapshot | undefined {
  const stored = parseObject(text);
  if (stored === undefined) {
    return undefined;
  }
  const ts = stringField(stored, 'ts');
  const sessionId = stringField(stored, 'session_id');
  if (ts === undefined || Number.isNaN(Date.parse(ts)) || sessionId === undefined || !CLAUDE_SESSION_ID.test(sessionId)) {
    return undefined;
  }
  const rateLimits = rateLimitsOf(stored['rate_limits']);
  const since = rateLimits === null ? null : timeUpTo(stored['rate_limits_since'], ts, true);
  return {
    ts,
    sessionId,
    cwd: stringField(stored, 'cwd') ?? '',
    agentName: textOrNull(stored['agent_name']),
    model: textOrNull(stored['model']),
    rateLimits,
    rateLimitsSince: since,
    rateLimitsAfter: rateLimits === null ? null : timeUpTo(stored['rate_limits_after'], since ?? ts, false),
    costUsd: finite(stored['cost_usd']),
    contextUsedPct: finite(stored['context_used_pct']),
    contextInputTokens: finite(stored['context_input_tokens']),
  };
}

/** `value` when it is a time before `bound`, or at it with `orAt`; else null, as a reading cannot be dated later than its file. */
function timeUpTo(value: unknown, bound: string, orAt: boolean): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const at = Date.parse(value);
  const limit = Date.parse(bound);
  return at < limit || (orAt && at === limit) ? value : null;
}

/** Whether two windows hold the same reading: equal use and reset, or both missing. */
function sameWindow(a: RateWindow | null, b: RateWindow | null): boolean {
  return a === null || b === null ? a === b : a.usedPct === b.usedPct && a.resetsAt === b.resetsAt;
}

/**
 * The snapshot with its reading dated by the session's previous snapshot. Rate limits that one showed
 * keep its dates, as Claude Code redraws the status line with the last reading until the session's next
 * reply; other rate limits came with a reply after it was written. Claude Code sets both windows from
 * each reply, so the five-hour window, which moves sooner, dates the week's reading too.
 */
export function datedSnapshot(snapshot: StatusSnapshot, previous: StatusSnapshot | undefined): StatusSnapshot {
  const limits = snapshot.rateLimits;
  if (limits === null || previous === undefined || previous.sessionId !== snapshot.sessionId) {
    return snapshot;
  }
  const shown = previous.rateLimits;
  if (shown !== null && sameWindow(limits.fiveHour, shown.fiveHour) && sameWindow(limits.sevenDay, shown.sevenDay)) {
    return { ...snapshot, rateLimitsSince: previous.rateLimitsSince ?? previous.ts, rateLimitsAfter: previous.rateLimitsAfter };
  }
  return { ...snapshot, rateLimitsAfter: Date.parse(previous.ts) < Date.parse(snapshot.ts) ? previous.ts : null };
}

/** The plan's use of the week, as the newest status line reading gives it. */
export interface WeekUse {
  readonly usedPct: number;
  readonly resetsAt: number;
  /** By when the reading was taken: when its session's snapshots began to show it. */
  readonly at: number;
}

/** A reading of the current week, taken after `after` (when known) and by `since`. */
interface DatedReading {
  readonly usedPct: number;
  readonly resetsAt: number;
  readonly after: number | undefined;
  readonly since: number;
}

/** The snapshot's reading of the week current at `now` (written by `now`, resetting after it), if it has one. */
function currentReadingOf(snapshot: StatusSnapshot, now: number): DatedReading | undefined {
  const week = snapshot.rateLimits?.sevenDay ?? null;
  if (week === null || Date.parse(snapshot.ts) > now || week.resetsAt <= now) {
    return undefined;
  }
  return {
    usedPct: week.usedPct,
    resetsAt: week.resetsAt,
    after: snapshot.rateLimitsAfter === null ? undefined : Date.parse(snapshot.rateLimitsAfter),
    since: Date.parse(snapshot.rateLimitsSince ?? snapshot.ts),
  };
}

/**
 * The week's use at `now` from the snapshots of every session. A week's use only grows, except when the
 * owner resets it mid-week (its reset time unchanged), and an exited session's file keeps its last
 * reading for good. So a reading taken by the time another is known to follow is dropped; of the rest,
 * which no reading is known to follow, the latest week's highest counts.
 */
export function weekUseOf(snapshots: readonly StatusSnapshot[], now: number): WeekUse | undefined {
  const readings = snapshots.flatMap((snapshot) => currentReadingOf(snapshot, now) ?? []);
  const followedBy = readings.reduce((latest, reading) => Math.max(latest, reading.after ?? Number.NEGATIVE_INFINITY), Number.NEGATIVE_INFINITY);
  let best: WeekUse | undefined;
  for (const reading of readings) {
    if (reading.since <= followedBy) {
      continue;
    }
    const later = best === undefined || reading.resetsAt > best.resetsAt;
    if (later || (reading.resetsAt === best?.resetsAt && reading.usedPct > best.usedPct)) {
      best = { usedPct: reading.usedPct, resetsAt: reading.resetsAt, at: reading.since };
    }
  }
  return best;
}

/** What the status line shows beside the snapshot: where the session works, and whether to show how to resume it. */
export interface StatusLineView {
  /** The session folder's name. */
  readonly folder?: string;
  /** The branch checked out there. */
  readonly branch?: string;
  /** The short id of a detached HEAD's commit, shown when there is no branch. */
  readonly commit?: string;
  /** Show `claude --resume <session id>`. */
  readonly resume: boolean;
}

/** Where the session works, such as `app on main`, `app at 1a2b3c4` (a detached HEAD) or `app`; empty when the view names nothing. */
function placeText(view: StatusLineView): string {
  const parts = view.folder === undefined ? [] : [view.folder];
  if (view.branch !== undefined) {
    parts.push(`on ${view.branch}`);
  } else if (view.commit !== undefined) {
    parts.push(`at ${view.commit}`);
  }
  return parts.join(' ');
}

/**
 * The status line text: the model, where the session works, the plan's use and the command that resumes the
 * session, such as `Opus 5.5, app on main, week 57%, 5h 6%, claude --resume <session id>`.
 */
export function statusLineText(snapshot: StatusSnapshot, view: StatusLineView): string {
  const parts = [snapshot.model ?? 'Claude'];
  const place = placeText(view);
  if (place !== '') {
    parts.push(place);
  }
  const week = snapshot.rateLimits?.sevenDay ?? null;
  const fiveHour = snapshot.rateLimits?.fiveHour ?? null;
  if (week !== null) {
    parts.push(`week ${Math.round(week.usedPct)}%`);
  }
  if (fiveHour !== null) {
    parts.push(`5h ${Math.round(fiveHour.usedPct)}%`);
  }
  if (view.resume) {
    parts.push(`claude --resume ${snapshot.sessionId}`);
  }
  return parts.join(', ');
}

/** Every snapshot in a folder; other files and unreadable ones are skipped. */
export async function readSnapshots(files: Pick<Files, 'list' | 'read'>, dir: string): Promise<StatusSnapshot[]> {
  const snapshots: StatusSnapshot[] = [];
  for (const name of await files.list(dir)) {
    const text = name.endsWith('.json') ? await files.read(join(dir, name)) : undefined;
    const snapshot = text === undefined ? undefined : parseSnapshot(text);
    if (snapshot !== undefined) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}
