import { isNonNegativeInteger, stringField } from "../core/guards.js";
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
/**
 * The team's session closes and reopens, an append-only log (`<state>/session-log.jsonl`): which running session
 * `teamrig close` or the idle pass ended to free the host, who, how long it had been idle and what it held, and when
 * `teamrig open` started it again, resumed in its last Claude Code session or fresh. A session whose newest
 * record is a close is closed by teamrig. A newer format is skipped on read and refuses a write.
 * A close's `folder` (T1408) is no new format, as the register's optional fields are none (src/register/events.ts):
 * no teamrig rewrites this log, and an older one ignores it and reopens the session in the project, fresh when its
 * transcript is not there. A new format would instead fail an older tab's close after its tab ended, unlogged.
 * A home close (no `claudeSession`, T1364) is no new format either: an older teamrig skips it as damaged and sees its
 * session as never closed, so only its idle pass leaves it home.
 */
export const SESSION_LOG_FORMAT = 1;
function instantField(record, key) {
    const value = stringField(record, key);
    return value !== undefined && Number.isFinite(Date.parse(value)) ? value : undefined;
}
function integerField(record, key) {
    const value = record[key];
    return isNonNegativeInteger(value) ? value : undefined;
}
/** One record as written; undefined for a line that is not one. */
export function parseSessionLogRecord(record) {
    const session = stringField(record, 'session');
    const at = instantField(record, 'at');
    if (session === undefined || at === undefined) {
        return undefined;
    }
    if (record['kind'] === 'reopen') {
        const resumed = stringField(record, 'resumed');
        return { kind: 'reopen', session, at, ...(resumed === undefined ? {} : { resumed }) };
    }
    const by = stringField(record, 'by');
    const claudeSession = stringField(record, 'claudeSession');
    const idleMinutes = integerField(record, 'idleMinutes');
    const freedMb = integerField(record, 'freedMb');
    if (record['kind'] !== 'close' || by === undefined || idleMinutes === undefined || freedMb === undefined) {
        return undefined;
    }
    const folder = stringField(record, 'folder');
    return { kind: 'close', session, by, at, ...(claudeSession === undefined ? {} : { claudeSession }), idleMinutes, freedMb, ...(folder === undefined ? {} : { folder }) };
}
/** The close that keeps a session hired with no room home until it has work and the host has room (T1364). */
export function homeCloseOf(session, by, at) {
    return { kind: 'close', session, by, at, idleMinutes: 0, freedMb: 0 };
}
function recordOf(record) {
    return { [VERSION_FIELD]: SESSION_LOG_FORMAT, ...record };
}
/** The close a session is in: its newest record when that is a close; undefined once it was reopened, or never closed. */
export function closedOf(records, session) {
    const newest = records.findLast((record) => record.session === session);
    return newest?.kind === 'close' ? newest : undefined;
}
/** The team's append-only log of session closes and reopens, oldest first. */
export class SessionLog {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        const parse = parseJsonl((await this.files.read(this.path)) ?? '');
        const records = [];
        for (const { record, version } of parse.records) {
            const parsed = version === SESSION_LOG_FORMAT ? parseSessionLogRecord(record) : undefined;
            if (parsed !== undefined) {
                records.push(parsed);
            }
        }
        return { records, skipped: parse.unreadable + parse.records.length - records.length };
    }
    /** One whole line in one append; refused beside records from a newer teamrig. */
    async append(record) {
        const text = (await this.files.read(this.path)) ?? '';
        assertWritable(this.path, parseJsonl(text), SESSION_LOG_FORMAT);
        const separator = text === '' || text.endsWith('\n') ? '' : '\n';
        await this.files.append(this.path, `${separator}${toJsonlLine(recordOf(record))}`);
    }
}
