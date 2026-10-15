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
 * - `cost_usd`, `context_used_pct`, `context_input_tokens`: numbers, or null.
 *
 * Claude Code sends `rate_limits` only to a claude.ai plan's sessions, after the session's first reply.
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
  return {
    ts: new Date(now).toISOString(),
    sessionId,
    cwd: (workspace === undefined ? undefined : stringField(workspace, 'current_dir')) ?? stringField(status, 'cwd') ?? '',
    agentName: textOrNull(recordField(status, 'agent')?.['name']),
    model: textOrNull(recordField(status, 'model')?.['display_name']),
    rateLimits: rateLimitsOf(status['rate_limits']),
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
  return {
    ts,
    sessionId,
    cwd: stringField(stored, 'cwd') ?? '',
    agentName: textOrNull(stored['agent_name']),
    model: textOrNull(stored['model']),
    rateLimits: rateLimitsOf(stored['rate_limits']),
    costUsd: finite(stored['cost_usd']),
    contextUsedPct: finite(stored['context_used_pct']),
    contextInputTokens: finite(stored['context_input_tokens']),
  };
}

/** The plan's use of the week, as the newest status line reading gives it. */
export interface WeekUse {
  readonly usedPct: number;
  readonly resetsAt: number;
  /** When the reading was taken. */
  readonly at: number;
}

/**
 * The week's use at `now` from the snapshots of every session: among readings of the current week
 * (taken by `now`, resetting after it), the highest, as a week's use only grows. A session's input
 * keeps its last reading until its next reply, so the newest file is not always the newest reading.
 */
export function weekUseOf(snapshots: readonly StatusSnapshot[], now: number): WeekUse | undefined {
  let best: WeekUse | undefined;
  for (const snapshot of snapshots) {
    const week = snapshot.rateLimits?.sevenDay ?? null;
    const at = Date.parse(snapshot.ts);
    if (week === null || at > now || week.resetsAt <= now) {
      continue;
    }
    const later = best === undefined || week.resetsAt > best.resetsAt;
    if (later || (week.resetsAt === best?.resetsAt && week.usedPct > best.usedPct)) {
      best = { usedPct: week.usedPct, resetsAt: week.resetsAt, at };
    }
  }
  return best;
}

/** The status line text: the model and the plan's use, such as `Opus 5.5, week 57%, 5h 6%`. */
export function statusLineText(snapshot: StatusSnapshot): string {
  const parts = [snapshot.model ?? 'Claude'];
  const week = snapshot.rateLimits?.sevenDay ?? null;
  const fiveHour = snapshot.rateLimits?.fiveHour ?? null;
  if (week !== null) {
    parts.push(`week ${Math.round(week.usedPct)}%`);
  }
  if (fiveHour !== null) {
    parts.push(`5h ${Math.round(fiveHour.usedPct)}%`);
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
