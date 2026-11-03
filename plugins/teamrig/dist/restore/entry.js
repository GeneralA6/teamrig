import { isNonNegativeInteger, isRecord, stringField } from "../core/guards.js";
import { ID_PATTERN } from "../core/ids.js";
import { parseObject } from "../core/jsonl.js";
import { MS_PER_MINUTE } from "../core/time.js";
import { CLAUDE_SESSION_ID } from "../inbox/marks.js";
const ACTIVITY_STATES = ['ready', 'working', 'error'];
/** The ends a person or Claude Code chose; any other end (`other`) may be the shutdown closing the terminal. */
export const INTENTIONAL_END_REASONS = new Set(['clear', 'resume', 'logout', 'prompt_input_exit']);
/** The reason an end without one of Claude Code's own is recorded under. */
export const OTHER_END = 'other';
/**
 * The least time between two writes a tool's end makes: often enough that a session's entry stays within minutes
 * of its transcript through a long turn (the fleet check reads a larger gap as a tab running without its hooks),
 * rare enough that most tool ends only read the entry.
 */
export const TOOL_END_WRITE_MS = 5 * MS_PER_MINUTE;
/** `entry` with its failed turn's state, left out when there is none. */
function withApiError(entry, apiError) {
    return apiError === undefined ? entry : { ...entry, apiError };
}
/**
 * How an event changes a session's entry. An end the person or Claude Code chose removes it: nothing is
 * left to restore. A start begins it afresh (ready, no restore pending). A first event that names no folder
 * writes nothing, since a tab cannot be reopened nowhere. A tool's end in the main thread marks it working (a
 * helper's runs on past its turn's end, and keeps the state), and either writes only once
 * `TOOL_END_WRITE_MS` passed since the entry's last write.
 *
 * A failed turn records its error and keeps the retry count; a good turn end or a start clears both. A prompt keeps
 * them, since a retry's own prompt starts the turn that may fail again.
 */
export function applyEvent(existing, event, facts) {
    if (event.kind === 'end' && event.reason !== undefined && INTENTIONAL_END_REASONS.has(event.reason)) {
        return { kind: 'remove' };
    }
    if (event.kind === 'tool' && existing !== undefined && existing.endedAt === undefined && facts.at - existing.updatedAt < TOOL_END_WRITE_MS) {
        return { kind: 'none' };
    }
    const projectDir = existing?.projectDir ?? facts.projectDir;
    if (projectDir === undefined) {
        return { kind: 'none' };
    }
    const base = {
        claudeSession: facts.claudeSession,
        projectDir,
        transcriptPath: facts.transcriptPath ?? existing?.transcriptPath,
        entrypoint: facts.entrypoint ?? existing?.entrypoint,
        sessionKind: facts.sessionKind ?? existing?.sessionKind,
        pid: facts.pid ?? existing?.pid,
        team: facts.team ?? existing?.team,
        session: facts.session ?? existing?.session,
        state: existing?.state ?? 'ready',
        createdAt: existing?.createdAt ?? facts.at,
        updatedAt: facts.at,
        restoreAttempts: existing?.restoreAttempts ?? 0,
        restoredAt: existing?.restoredAt,
        endedAt: undefined,
        endReason: undefined,
    };
    const kept = existing?.apiError;
    switch (event.kind) {
        case 'end':
            return { kind: 'write', entry: withApiError({ ...base, endedAt: facts.at, endReason: event.reason ?? OTHER_END }, kept) };
        case 'start':
            return { kind: 'write', entry: { ...base, state: 'ready', restoreAttempts: 0, restoredAt: undefined } };
        case 'tool':
            return { kind: 'write', entry: withApiError(event.mainThread ? { ...base, state: 'working' } : base, kept) };
        case 'working':
            return { kind: 'write', entry: withApiError({ ...base, state: 'working' }, kept) };
        case 'ready':
            return { kind: 'write', entry: { ...base, state: 'ready' } };
        case 'error': {
            const apiError = { code: event.code, failedAt: facts.at, retries: kept?.retries ?? 0, retriedAt: kept?.retriedAt };
            return { kind: 'write', entry: { ...base, state: 'error', apiError } };
        }
    }
}
function isoOf(ms) {
    return ms === undefined ? undefined : new Date(ms).toISOString();
}
/** The entry as its file's JSON object: times as ISO instants, fields that are not set undefined, which JSON leaves out. */
export function entryRecord(entry) {
    const { apiError } = entry;
    return {
        claudeSession: entry.claudeSession,
        projectDir: entry.projectDir,
        transcriptPath: entry.transcriptPath,
        entrypoint: entry.entrypoint,
        sessionKind: entry.sessionKind,
        pid: entry.pid,
        team: entry.team,
        session: entry.session,
        state: entry.state,
        createdAt: isoOf(entry.createdAt),
        updatedAt: isoOf(entry.updatedAt),
        restoreAttempts: entry.restoreAttempts,
        restoredAt: isoOf(entry.restoredAt),
        endedAt: isoOf(entry.endedAt),
        endReason: entry.endReason,
        apiError: apiError === undefined ? undefined : { code: apiError.code, failedAt: isoOf(apiError.failedAt), retries: apiError.retries, retriedAt: isoOf(apiError.retriedAt) },
    };
}
/** The entry's file text: `entryRecord` as indented JSON. */
export function formatEntry(entry) {
    return `${JSON.stringify(entryRecord(entry), null, 2)}\n`;
}
/** An optional instant; null when it is there but not an instant. */
function instantField(record, key) {
    if (record[key] === undefined) {
        return undefined;
    }
    const text = stringField(record, key);
    const ms = text === undefined ? Number.NaN : Date.parse(text);
    return Number.isNaN(ms) ? null : ms;
}
/** An optional team or session id, which a tab's command line carries; null when it is there but not an id. */
function idField(record, key) {
    if (record[key] === undefined) {
        return undefined;
    }
    const id = stringField(record, key);
    return id !== undefined && ID_PATTERN.test(id) ? id : null;
}
function activityOf(text) {
    return ACTIVITY_STATES.find((state) => state === text);
}
/**
 * The failed turn's state a file holds; undefined when there is none or it is damaged. A damaged one never skips the
 * entry, which the restore after a reboot needs: it only loses the retry count.
 */
function apiErrorOf(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const code = stringField(value, 'code');
    const failedAt = instantField(value, 'failedAt');
    const retriedAt = instantField(value, 'retriedAt');
    const retries = value['retries'];
    if ((value['code'] !== undefined && code === undefined) || failedAt === undefined || failedAt === null || retriedAt === null || !isNonNegativeInteger(retries)) {
        return undefined;
    }
    return { code, failedAt, retries, retriedAt };
}
/** An entry file's text; undefined when it is damaged or of another shape, which the restore then skips. */
export function parseEntry(text) {
    const record = parseObject(text.trim());
    return record === undefined ? undefined : entryOfRecord(record);
}
/** The entry an `entryRecord` object holds; undefined when it is of another shape. */
export function entryOfRecord(record) {
    const claudeSession = stringField(record, 'claudeSession');
    const projectDir = stringField(record, 'projectDir');
    const state = activityOf(stringField(record, 'state'));
    const createdAt = instantField(record, 'createdAt');
    const updatedAt = instantField(record, 'updatedAt');
    const restoredAt = instantField(record, 'restoredAt');
    const endedAt = instantField(record, 'endedAt');
    const team = idField(record, 'team');
    const session = idField(record, 'session');
    const rawPid = record['pid'];
    const pid = rawPid === undefined ? undefined : isNonNegativeInteger(rawPid) ? rawPid : null;
    const restoreAttempts = record['restoreAttempts'];
    if (claudeSession === undefined ||
        !CLAUDE_SESSION_ID.test(claudeSession) ||
        projectDir === undefined ||
        state === undefined ||
        createdAt === undefined ||
        createdAt === null ||
        updatedAt === undefined ||
        updatedAt === null ||
        restoredAt === null ||
        endedAt === null ||
        team === null ||
        session === null ||
        !isNonNegativeInteger(restoreAttempts) ||
        pid === null) {
        return undefined;
    }
    const entry = {
        claudeSession,
        projectDir,
        transcriptPath: stringField(record, 'transcriptPath'),
        entrypoint: stringField(record, 'entrypoint'),
        sessionKind: stringField(record, 'sessionKind'),
        pid,
        team,
        session,
        state,
        createdAt,
        updatedAt,
        restoreAttempts,
        restoredAt,
        endedAt,
        endReason: stringField(record, 'endReason'),
    };
    return withApiError(entry, apiErrorOf(record['apiError']));
}
