import { isNonNegativeInteger, stringField } from "../core/guards.js";
import { ID_PATTERN } from "../core/ids.js";
import { parseObject } from "../core/jsonl.js";
import { CLAUDE_SESSION_ID } from "../inbox/marks.js";
const ACTIVITY_STATES = ['ready', 'working', 'error'];
/** The ends a person or Claude Code chose; any other end (`other`) may be the shutdown closing the terminal. */
export const INTENTIONAL_END_REASONS = new Set(['clear', 'resume', 'logout', 'prompt_input_exit']);
/** The reason an end without one of Claude Code's own is recorded under. */
export const OTHER_END = 'other';
/**
 * How an event changes a session's entry. An end the person or Claude Code chose removes it: nothing is
 * left to restore. A start begins it afresh (ready, no restore pending). A first event that names no folder
 * writes nothing, since a tab cannot be reopened nowhere.
 */
export function applyEvent(existing, event, facts) {
    if (event.kind === 'end' && event.reason !== undefined && INTENTIONAL_END_REASONS.has(event.reason)) {
        return { kind: 'remove' };
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
    switch (event.kind) {
        case 'end':
            return { kind: 'write', entry: { ...base, endedAt: facts.at, endReason: event.reason ?? OTHER_END } };
        case 'start':
            return { kind: 'write', entry: { ...base, state: 'ready', restoreAttempts: 0, restoredAt: undefined } };
        case 'working':
        case 'ready':
        case 'error':
            return { kind: 'write', entry: { ...base, state: event.kind } };
    }
}
function isoOf(ms) {
    return ms === undefined ? undefined : new Date(ms).toISOString();
}
/** The entry's file text: times as ISO instants, fields that are not set left out. */
export function formatEntry(entry) {
    const record = {
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
    };
    return `${JSON.stringify(record, null, 2)}\n`;
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
/** An entry file's text; undefined when it is damaged or of another shape, which the restore then skips. */
export function parseEntry(text) {
    const record = parseObject(text.trim());
    if (record === undefined) {
        return undefined;
    }
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
    return {
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
}
