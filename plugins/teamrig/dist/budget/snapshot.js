import { basename, join } from 'node:path';
import { isRecord, recordField, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { CLAUDE_SESSION_ID } from "../inbox/marks.js";
const MS_PER_SECOND = 1000;
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function textOrNull(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}
/** A window in the stored or Claude Code shape: `used_percentage` and `resets_at` in epoch seconds. */
function rateWindowOf(value) {
    if (!isRecord(value)) {
        return null;
    }
    const usedPct = finite(value['used_percentage']);
    const resetsAt = finite(value['resets_at']);
    return usedPct === null || resetsAt === null ? null : { usedPct, resetsAt: resetsAt * MS_PER_SECOND };
}
function rateLimitsOf(value) {
    if (!isRecord(value)) {
        return null;
    }
    const fiveHour = rateWindowOf(value['five_hour']);
    const sevenDay = rateWindowOf(value['seven_day']);
    return fiveHour === null && sevenDay === null ? null : { fiveHour, sevenDay };
}
/** The Claude Code session id of a status input: `session_id`, else the transcript's file name. */
function sessionIdOf(status) {
    const transcript = stringField(status, 'transcript_path');
    const id = stringField(status, 'session_id') ?? (transcript === undefined ? undefined : basename(transcript, '.jsonl'));
    return id !== undefined && CLAUDE_SESSION_ID.test(id) ? id : undefined;
}
/**
 * The snapshot of Claude Code's status line input (its JSON on stdin), taken at `now`; undefined when
 * the input is not a JSON object or names no valid session id, which also keeps the file name safe.
 */
export function snapshotOfStatus(input, now) {
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
function storedWindow(window) {
    return window === null ? null : { used_percentage: window.usedPct, resets_at: Math.round(window.resetsAt / MS_PER_SECOND) };
}
/** The snapshot as its file's text. */
export function formatSnapshot(snapshot) {
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
export function parseSnapshot(text) {
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
/**
 * The week's use at `now` from the snapshots of every session: among readings of the current week
 * (taken by `now`, resetting after it), the highest, as a week's use only grows. A session's input
 * keeps its last reading until its next reply, so the newest file is not always the newest reading.
 */
export function weekUseOf(snapshots, now) {
    let best;
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
export function statusLineText(snapshot) {
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
export async function readSnapshots(files, dir) {
    const snapshots = [];
    for (const name of await files.list(dir)) {
        const text = name.endsWith('.json') ? await files.read(join(dir, name)) : undefined;
        const snapshot = text === undefined ? undefined : parseSnapshot(text);
        if (snapshot !== undefined) {
            snapshots.push(snapshot);
        }
    }
    return snapshots;
}
