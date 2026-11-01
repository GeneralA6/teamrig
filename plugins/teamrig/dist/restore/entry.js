import { isNonNegativeInteger, stringField } from "../core/guards.js";
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
/**
 * How an event changes a session's entry. An end the person or Claude Code chose removes it: nothing is
 * left to restore. A start begins it afresh (ready, no restore pending). A first event that names no folder
 * writes nothing, since a tab cannot be reopened nowhere. A tool's end in the main thread marks it working (a
 * helper's runs on past its turn's end, and keeps the state), and either writes only once
 * `TOOL_END_WRITE_MS` passed since the entry's last write.
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
    switch (event.kind) {
        case 'end':
            return { kind: 'write', entry: { ...base, endedAt: facts.at, endReason: event.reason ?? OTHER_END } };
        case 'start':
            return { kind: 'write', entry: { ...base, state: 'ready', restoreAttempts: 0, restoredAt: undefined } };
        case 'tool':
            return { kind: 'write', entry: event.mainThread ? { ...base, state: 'working' } : base };
        case 'working':
        case 'ready':
        case 'error':
            return { kind: 'write', entry: { ...base, state: event.kind } };
    }
}
function isoOf(ms) {
    return ms === undefined ? undefined : new Date(ms).toISOString();
}
/** The entry as its file's JSON object: times as ISO instants, fields that are not set undefined, which JSON leaves out. */
export function entryRecord(entry) {
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
