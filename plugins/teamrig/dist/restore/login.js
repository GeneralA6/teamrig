import { join } from 'node:path';
import { isRecord, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { MS_PER_DAY } from "../core/time.js";
import { CLAUDE_SESSION_ID } from "../inbox/marks.js";
/**
 * The Claude login as the fleet saw it last: when it expired, and which tabs a turn that ended on `Login expired`
 * left stuck. The login is the account's, shared by every team and tab of the kit home, so there is one marker per
 * kit home. `hook restore-track` writes it on an auth failure and on the next good turn end, under a lock, since a
 * day-start wake fails a dozen tabs in the same second.
 */
/** The marker's file, beside the restore's sessions folder and log. */
export function loginMarkerPath(kitHome) {
    return join(kitHome, 'restore', 'login.json');
}
/** The marker's lock: held only for a read and a write of one small file, so a waiter gives up after a few seconds. */
export const LOGIN_LOCK = { ttlMs: 10_000, pollMs: 25, waitMs: 5_000 };
/** How long a tab stays stranded with no good turn: one closed meanwhile, or never retried, leaves the marker. */
export const STRANDED_KEEP_MS = 2 * MS_PER_DAY;
/** How much of a transcript's end is read for the error record of a turn that failed: it is the turn's last record. */
export const LOGIN_TAIL_BYTES = 64 * 1024;
/** The error Claude Code names an expired or revoked login by, in a StopFailure payload and its transcript record. */
export const AUTH_FAILED = 'authentication_failed';
/** True while the marker's latest expiry has no good turn after it. */
export function loginExpired(marker) {
    return marker.recoveredAt === undefined;
}
/**
 * Whether a StopFailure ended its turn on the login. The payload's `error` decides it; only a payload with none reads
 * the transcript's end (`tailOf`, undefined when there is none), whose last assistant record is the turn's synthetic
 * error message.
 */
export async function authFailureOf(payload, tailOf) {
    const error = stringField(payload, 'error');
    if (error !== undefined) {
        return error === AUTH_FAILED;
    }
    const tail = await tailOf();
    return tail !== undefined && lastAssistantFailedAuth(tail);
}
/** True when the last assistant record of `text` is an API error message for an auth failure; a torn first line is skipped. */
function lastAssistantFailedAuth(text) {
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? '';
        const record = line.includes('"assistant"') ? parseObject(line) : undefined;
        if (record?.['type'] === 'assistant') {
            return record['isApiErrorMessage'] === true && record['error'] === AUTH_FAILED;
        }
    }
    return false;
}
/** The tabs still stranded at `at`: one stuck longer than `STRANDED_KEEP_MS` is dropped. */
function keptStranded(stranded, at) {
    return new Map([...stranded].filter(([, failAt]) => at - failAt <= STRANDED_KEEP_MS));
}
function sameStranded(left, right) {
    return left.size === right.size && [...left].every(([tab, at]) => right.get(tab) === at);
}
/** `stranded` with `tab` failed at `at`, keeping a later failure already there. */
function withStranded(stranded, tab, at) {
    const next = new Map(stranded);
    next.set(tab, Math.max(at, stranded.get(tab) ?? at));
    return next;
}
function authFailed(existing, tab, at) {
    const stranded = withStranded(keptStranded(existing?.stranded ?? new Map(), at), tab, at);
    // A failure after the recovery, or the first one ever, starts a new expiry.
    if (existing === undefined || (existing.recoveredAt !== undefined && at > existing.recoveredAt)) {
        return { kind: 'write', marker: { expiredAt: at, lastFailAt: at, recoveredAt: undefined, stranded }, note: 'expired' };
    }
    // A failure the hooks report after a later recovery (out of order) belongs to the expiry that ended: it only strands its tab.
    if (existing.recoveredAt !== undefined) {
        return { kind: 'write', marker: { ...existing, lastFailAt: Math.max(existing.lastFailAt, at), stranded }, note: 'stranded' };
    }
    const marker = { ...existing, expiredAt: Math.min(existing.expiredAt, at), lastFailAt: Math.max(existing.lastFailAt, at), stranded };
    return { kind: 'write', marker, note: 'stranded' };
}
/**
 * A good turn end proves the login works when it comes after the latest failure: its model answer needed the
 * login. A tool's end does not (its request may predate the expiry), nor a start (it calls no API). It frees its own
 * tab only from a failure before it.
 */
function answered(existing, tab, at) {
    if (existing === undefined) {
        return { kind: 'none' };
    }
    const stranded = keptStranded(existing.stranded, at);
    const failAt = stranded.get(tab);
    if (failAt !== undefined && failAt < at) {
        stranded.delete(tab);
    }
    const recovers = loginExpired(existing) && at > existing.lastFailAt;
    if (!recovers && sameStranded(stranded, existing.stranded)) {
        return { kind: 'none' };
    }
    const marker = { ...existing, recoveredAt: recovers ? at : existing.recoveredAt, stranded };
    return { kind: 'write', marker, note: recovers ? 'recovered' : undefined };
}
/** How a turn end changes the marker (`existing`, undefined when there is none yet). */
export function applyLoginEvent(existing, event) {
    return event.kind === 'auth-failed' ? authFailed(existing, event.claudeSession, event.at) : answered(existing, event.claudeSession, event.at);
}
/** The restore log's line for a change's note: `tab` names the tab whose turn end made it. */
export function loginLogLine(note, tab, marker) {
    const stuck = `${marker.stranded.size} tab(s) stuck`;
    switch (note) {
        case 'expired':
            return `login: expired, ${tab} ended its turn on Login expired; ${stuck}`;
        case 'stranded':
            return `login: ${tab} ended its turn on Login expired; ${stuck}`;
        case 'recovered':
            return `login: works again, ${tab} answered; ${stuck}`;
    }
}
function isoOf(ms) {
    return new Date(ms).toISOString();
}
/** The marker's file text: times as ISO instants, indented JSON. */
export function formatLoginMarker(marker) {
    const record = {
        expiredAt: isoOf(marker.expiredAt),
        lastFailAt: isoOf(marker.lastFailAt),
        recoveredAt: marker.recoveredAt === undefined ? undefined : isoOf(marker.recoveredAt),
        stranded: Object.fromEntries([...marker.stranded].map(([tab, at]) => [tab, isoOf(at)])),
    };
    return `${JSON.stringify(record, null, 2)}\n`;
}
/** An instant field; undefined when it is missing or not an instant. */
function instantOf(record, key) {
    const text = stringField(record, key);
    const ms = text === undefined ? Number.NaN : Date.parse(text);
    return Number.isNaN(ms) ? undefined : ms;
}
/** The stranded tabs; undefined when a key is not a Claude session id or a time not an instant. */
function strandedOf(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const stranded = new Map();
    for (const tab of Object.keys(value)) {
        const at = instantOf(value, tab);
        if (!CLAUDE_SESSION_ID.test(tab) || at === undefined) {
            return undefined;
        }
        stranded.set(tab, at);
    }
    return stranded;
}
/** The marker a file holds; undefined when it is damaged or of another shape, which the next auth failure replaces. */
export function parseLoginMarker(text) {
    const record = parseObject(text.trim());
    if (record === undefined) {
        return undefined;
    }
    const expiredAt = instantOf(record, 'expiredAt');
    const lastFailAt = instantOf(record, 'lastFailAt');
    const recoveredAt = instantOf(record, 'recoveredAt');
    const stranded = strandedOf(record['stranded']);
    if (expiredAt === undefined || lastFailAt === undefined || stranded === undefined || (record['recoveredAt'] !== undefined && recoveredAt === undefined)) {
        return undefined;
    }
    return { expiredAt, lastFailAt, recoveredAt, stranded };
}
