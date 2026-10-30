import { isEffortLevel } from "../config/types.js";
import { stringField } from "../core/guards.js";
import { parseJsonl } from "../core/jsonl.js";
import { parseUtcDay } from "../core/time.js";
/**
 * The team's hires, keeps and retires, an append-only log: who joined for what job, on whose say-so, until which
 * review day, for which burst if any; who kept it on to a later review day, and why; and who left, with which
 * handover and to which heir. A session whose newest hire or retire is a hire is a hired session.
 */
/**
 * The format of the hire log's records; a newer one is skipped on read and refuses a write. Format 2 dropped the
 * hire's fixed `dailyPct`, so a teamrig that still requires it refuses to write beside a hire it cannot read. A keep
 * needs no new format: an older teamrig skips it as a damaged line, so it only misses the new review day.
 */
export const HIRE_FORMAT = 2;
/** The formats read: a hire stays on the team for weeks, so a format-1 hire still counts, its `dailyPct` ignored. */
const READ_FORMATS = [1, HIRE_FORMAT];
export function isHire(record) {
    return record.kind === 'hire';
}
function isRetire(record) {
    return record.kind === 'retire';
}
function isKeep(record) {
    return record.kind === 'keep';
}
/**
 * Each session's newest hire or retire, in the order the sessions first appear. A keep moves the review day of the
 * hire it follows; one after a retire, or before any hire, keeps nothing.
 */
function newestBySession(records) {
    const newest = new Map();
    for (const record of records) {
        if (!isKeep(record)) {
            newest.set(record.session, record);
            continue;
        }
        const kept = newest.get(record.session);
        if (kept !== undefined && isHire(kept)) {
            newest.set(record.session, { ...kept, reviewBy: record.reviewBy });
        }
    }
    return [...newest.values()];
}
/**
 * The sessions hired and not retired since, each with its newest hire at the review day of its newest keep, in the
 * order they were first hired.
 */
export function activeHires(records) {
    return newestBySession(records).filter(isHire);
}
/** The sessions retired and not hired again since, each with its retire, in the order they first appear. */
export function retiredSessions(records) {
    return newestBySession(records).filter(isRetire);
}
/**
 * The retire a hired session came back from: the retire before its newest hire, when that hire is a rehire of a
 * retired id. Undefined for a first hire, a retired session, or an id with no record.
 */
export function rehiredFrom(records, session) {
    let retire;
    let from;
    for (const record of records) {
        if (record.session !== session) {
            continue;
        }
        if (isHire(record)) {
            from = retire;
        }
        else if (isRetire(record)) {
            retire = record;
            from = undefined;
        }
    }
    return from;
}
function instantOf(record, key) {
    const text = stringField(record, key);
    const at = text === undefined ? Number.NaN : Date.parse(text);
    return Number.isNaN(at) ? undefined : at;
}
/** One record as a hire, a keep or a retire; undefined when it is damaged. */
export function parseHiringRecord(record) {
    const session = stringField(record, 'session');
    const reason = stringField(record, 'reason');
    const by = stringField(record, 'by');
    const at = instantOf(record, 'at');
    if (session === undefined || reason === undefined || by === undefined || at === undefined) {
        return undefined;
    }
    if (record['kind'] === 'keep') {
        const reviewBy = stringField(record, 'reviewBy');
        return reviewBy === undefined || parseUtcDay(reviewBy) === undefined ? undefined : { kind: 'keep', session, reviewBy, reason, by, at };
    }
    if (record['kind'] === 'retire') {
        const handover = stringField(record, 'handover');
        const noHandover = stringField(record, 'noHandover');
        const heir = stringField(record, 'heir');
        return {
            kind: 'retire',
            session,
            reason,
            by,
            at,
            ...(handover === undefined ? {} : { handover }),
            ...(noHandover === undefined ? {} : { noHandover }),
            ...(heir === undefined ? {} : { heir }),
        };
    }
    const scope = stringField(record, 'scope');
    const reviewBy = stringField(record, 'reviewBy');
    const effort = record['effort'];
    const approvedBy = stringField(record, 'approvedBy');
    const model = stringField(record, 'model');
    const burst = instantOf(record, 'burst');
    if (record['burst'] !== undefined && burst === undefined) {
        return undefined;
    }
    if (record['kind'] !== 'hire' || scope === undefined || reviewBy === undefined || parseUtcDay(reviewBy) === undefined) {
        return undefined;
    }
    if (effort !== undefined && !isEffortLevel(effort)) {
        return undefined;
    }
    return {
        kind: 'hire',
        session,
        scope,
        reason,
        ...(approvedBy === undefined ? {} : { approvedBy }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        reviewBy,
        ...(burst === undefined ? {} : { burst }),
        by,
        at,
    };
}
/** A hire log's text as its records, oldest first; damaged lines and lines from a newer teamrig are skipped. */
export function readHiringLog(text) {
    const parse = parseJsonl(text);
    const records = [];
    for (const { record, version } of parse.records) {
        const parsed = READ_FORMATS.includes(version) ? parseHiringRecord(record) : undefined;
        if (parsed !== undefined) {
            records.push(parsed);
        }
    }
    return { records, skipped: parse.unreadable + parse.records.length - records.length };
}
