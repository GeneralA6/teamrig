import { basename, isAbsolute, join } from 'node:path';
import { isRecord, recordField, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { isTemporaryName } from "../core/files.js";
import { MS_PER_DAY, MS_PER_HOUR } from "../core/time.js";
import { CLAUDE_SESSION_ID } from "../inbox/marks.js";
import { coloured } from "../meeting/status-line.js";
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
/**
 * The session's effort level in Claude Code's status line input (`effort.level`, which Claude Code sends only
 * for a model that takes one); undefined without it. The status line shows it; the snapshot does not keep it.
 */
export function effortOfStatus(input) {
    const status = parseObject(input.trim());
    const effort = status === undefined ? undefined : recordField(status, 'effort');
    return textOrNull(effort?.['level']) ?? undefined;
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
        rate_limits_since: snapshot.rateLimitsSince,
        rate_limits_after: snapshot.rateLimitsAfter,
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
function timeUpTo(value, bound, orAt) {
    if (typeof value !== 'string') {
        return null;
    }
    const at = Date.parse(value);
    const limit = Date.parse(bound);
    return at < limit || (orAt && at === limit) ? value : null;
}
/** Whether two windows hold the same reading: equal use and reset, or both missing. */
function sameWindow(a, b) {
    return a === null || b === null ? a === b : a.usedPct === b.usedPct && a.resetsAt === b.resetsAt;
}
/**
 * The snapshot with its reading dated by the session's previous snapshot. Rate limits that one showed
 * keep its dates, as Claude Code redraws the status line with the last reading until the session's next
 * reply; other rate limits came with a reply after it was written. Claude Code sets both windows from
 * each reply, so the five-hour window, which moves sooner, dates the week's reading too.
 */
export function datedSnapshot(snapshot, previous) {
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
/**
 * The snapshot's reading of the week current at `now` (taken by `now`, resetting after it), if it has one. It is
 * dated by when its session began to show it, not by the file's `ts`: a redraw rewrites the file with the same
 * reading, so a reader whose own tab redraws while it reads would otherwise skip that tab's newest reading.
 */
function currentReadingOf(snapshot, now) {
    const week = snapshot.rateLimits?.sevenDay ?? null;
    const since = Date.parse(snapshot.rateLimitsSince ?? snapshot.ts);
    if (week === null || since > now || week.resetsAt <= now) {
        return undefined;
    }
    return {
        usedPct: week.usedPct,
        resetsAt: week.resetsAt,
        after: snapshot.rateLimitsAfter === null ? undefined : Date.parse(snapshot.rateLimitsAfter),
        since,
    };
}
/** `use` when it counts over `best`: of a later week, or of the same week and higher. */
function countsOver(best, use) {
    const later = best === undefined || use.resetsAt > best.resetsAt;
    return later || (use.resetsAt === best.resetsAt && use.usedPct > best.usedPct) ? use : best;
}
function latestOf(a, b) {
    return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}
function useOf({ usedPct, resetsAt, after, since }) {
    const use = { usedPct, resetsAt, at: since };
    return after === undefined ? use : { ...use, after };
}
/**
 * The snapshots' readings of the week current at `now`, folded. A week's use only grows, except when the
 * owner resets it mid-week (its reset time unchanged), and an exited session's file keeps its last
 * reading for good. So a reading taken by the time another is known to follow is dropped; of the rest,
 * which no reading is known to follow, the latest week's highest counts.
 */
export function weekFoldOf(snapshots, now) {
    const readings = snapshots.flatMap((snapshot) => currentReadingOf(snapshot, now) ?? []);
    const followedBy = readings.reduce((latest, reading) => latestOf(latest, reading.after), undefined);
    let best;
    for (const reading of readings) {
        if (followedBy === undefined || reading.since > followedBy) {
            best = countsOver(best, useOf(reading));
        }
    }
    return { best, followedBy };
}
/**
 * Two folds as one, as the fold of both their readings: the later follower time drops the reading of either
 * taken by then, and of the rest the latest week's highest counts. A reading that lost to the other fold's is
 * not kept, so when the follower time then drops the winner the loser cannot come back; a week's use only grows,
 * so a reading that would is never higher than the one that drops the winner.
 */
export function mergeWeekFolds(a, b) {
    const followedBy = latestOf(a.followedBy, b.followedBy);
    let best;
    for (const use of [a.best, b.best]) {
        if (use !== undefined && (followedBy === undefined || use.at > followedBy)) {
            best = countsOver(best, use);
        }
    }
    return { best, followedBy };
}
/**
 * The fold's reading when its week is still current at `now`, resetting after it. A reading dated after `now`
 * counts too: the status line folds each reading as it is shown, so one dated after a reader took its clock was
 * folded while it read, and it replaced the reading the reader would otherwise have found.
 */
export function weekUseAt(fold, now) {
    const { best } = fold;
    return best === undefined || best.resetsAt <= now ? undefined : best;
}
/** Where the session works, such as `app on main`, `app at 1a2b3c4` (a detached HEAD) or `app`; empty when the view names nothing. */
function placeText(view) {
    const parts = view.folder === undefined ? [] : [view.folder];
    if (view.branch !== undefined) {
        parts.push(`on ${view.branch}`);
    }
    else if (view.commit !== undefined) {
        parts.push(`at ${view.commit}`);
    }
    return parts.join(' ');
}
/**
 * The status line text: the model and its effort level, where the session works, and the plan's use, the week's
 * beside where the pace line stands, such as `Opus 5.5 (high), app on main, week 57% (pace 53%), 5h 6%`.
 */
export function statusLineText(snapshot, view) {
    const model = snapshot.model ?? 'Claude';
    const parts = [view.effort === undefined ? model : `${model} (${view.effort})`];
    const place = placeText(view);
    if (place !== '') {
        parts.push(place);
    }
    const week = snapshot.rateLimits?.sevenDay ?? null;
    const fiveHour = snapshot.rateLimits?.fiveHour ?? null;
    if (week !== null) {
        const used = `week ${Math.round(week.usedPct)}%`;
        parts.push(view.pacePct === undefined ? used : `${used} (pace ${Math.round(view.pacePct)}%)`);
    }
    if (fiveHour !== null) {
        parts.push(`5h ${Math.round(fiveHour.usedPct)}%`);
    }
    const meeting = view.meeting;
    if (meeting?.kind === 'held') {
        parts.push(meeting.text);
    }
    const text = parts.join(', ');
    return meeting?.kind === 'tab' ? coloured(text, meeting.colour) : text;
}
async function readSnapshotFiles(files, dir) {
    const found = [];
    for (const name of await files.list(dir)) {
        const path = join(dir, name);
        const text = name.endsWith('.json') ? await files.read(path) : undefined;
        const snapshot = text === undefined ? undefined : parseSnapshot(text);
        if (snapshot !== undefined) {
            found.push({ path, snapshot });
        }
    }
    return found;
}
/** Where the status line snapshots are: `budget.statusSnapshotDir` (relative to the team's folder), else `<kit home>/usage/live`. */
export function snapshotDirOf(budget, paths) {
    const dir = budget.statusSnapshotDir;
    if (dir === undefined) {
        return defaultSnapshotDir(paths.kitHome);
    }
    return isAbsolute(dir) ? dir : join(paths.home, dir);
}
export function defaultSnapshotDir(kitHome) {
    return join(kitHome, 'usage', 'live');
}
/** Every snapshot in a folder; other files and unreadable ones are skipped. */
export async function readSnapshots(files, dir) {
    return (await readSnapshotFiles(files, dir)).map((each) => each.snapshot);
}
/**
 * Days a snapshot is kept after it was written: 8, as many as the usage files keep a day's totals. A
 * reading is taken by its snapshot's `ts` and its week resets at most 7 days later, so a snapshot older
 * than that holds no reading of the current week (`weekFoldOf` skips it), and a session that shows the
 * reading again after a pause needs no previous snapshot to date it.
 */
export const SNAPSHOT_DAYS_KEPT = 8;
/** At most one sweep of a folder per hour, so a status line redraw reads one small file, not the folder. */
export const SNAPSHOT_PRUNE_EVERY_MS = MS_PER_HOUR;
/** The file in a snapshot folder that holds when it was last swept, ISO 8601 UTC; not a `.json` name, so no reader takes it for a snapshot. */
export const SNAPSHOT_PRUNED_FILE = '.pruned';
/**
 * How long a write's temporary sibling stays in the folder: a write holds one for milliseconds, so one an hour old
 * was left by a write stopped before its rename, and no write will rename it.
 */
export const SNAPSHOT_TEMPORARY_KEPT_MS = MS_PER_HOUR;
/** Whether the folder was last swept within the hour before `now`, as its marker says; a missing, damaged or future time is not. */
function sweptRecently(marker, now) {
    const at = marker === undefined ? Number.NaN : Date.parse(marker.trim());
    return at <= now && now - at < SNAPSHOT_PRUNE_EVERY_MS;
}
/**
 * Removes the folder's snapshots written more than `SNAPSHOT_DAYS_KEPT` days before `now` and the temporary
 * siblings its writes left (`SNAPSHOT_TEMPORARY_KEPT_MS`), so the folder holds the sessions of the last 8 days,
 * not every session ever run, and every reader's walk of it stays bounded. It sweeps at most once an hour per
 * folder, claimed by stamping the marker file first (two status lines that sweep together remove the same files,
 * which is harmless); in between it reads only the marker. Other files, damaged snapshots among them, are left
 * alone. Returns how many files it removed: 0 when no sweep was due.
 */
export async function pruneSnapshots(files, dir, now) {
    const marker = join(dir, SNAPSHOT_PRUNED_FILE);
    if (sweptRecently(await files.read(marker), now)) {
        return 0;
    }
    await files.write(marker, new Date(now).toISOString());
    return (await removeOldSnapshots(files, dir, now)) + (await removeLeftTemporaries(files, dir, now));
}
/** Removes the folder's snapshots written more than `SNAPSHOT_DAYS_KEPT` days before `now`; returns how many. */
async function removeOldSnapshots(files, dir, now) {
    const oldest = now - SNAPSHOT_DAYS_KEPT * MS_PER_DAY;
    let removed = 0;
    for (const { path, snapshot } of await readSnapshotFiles(files, dir)) {
        if (Date.parse(snapshot.ts) < oldest && (await files.remove(path))) {
            removed += 1;
        }
    }
    return removed;
}
/** Removes the folder's temporary siblings last changed more than `SNAPSHOT_TEMPORARY_KEPT_MS` before `now`; returns how many. */
async function removeLeftTemporaries(files, dir, now) {
    let removed = 0;
    for (const name of (await files.list(dir)).filter(isTemporaryName)) {
        const path = join(dir, name);
        const changedAt = await files.modifiedAt(path);
        if (changedAt !== undefined && now - changedAt > SNAPSHOT_TEMPORARY_KEPT_MS && (await files.remove(path))) {
            removed += 1;
        }
    }
    return removed;
}
