import { isEffortLevel } from "../config/types.js";
import { stringField } from "../core/guards.js";
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { parseUtcDay } from "../core/time.js";
/**
 * The team's hires and retires, an append-only log: who joined for what job, on whose say-so, at what
 * daily budget and until which review day, and who left, with which handover and to which heir. A
 * session whose newest record is a hire is a hired session.
 */
/** The format of the hire log's records; a newer one is skipped on read and refuses a write. */
export const HIRE_FORMAT = 1;
function isHire(record) {
    return record.kind === 'hire';
}
function isRetire(record) {
    return record.kind === 'retire';
}
/** Each session's newest record, in the order the sessions first appear. */
function newestBySession(records) {
    const newest = new Map();
    for (const record of records) {
        newest.set(record.session, record);
    }
    return [...newest.values()];
}
/** The sessions hired and not retired since, each with its newest hire, in the order they were first hired. */
export function activeHires(records) {
    return newestBySession(records).filter(isHire);
}
/** The sessions retired and not hired again since, each with its retire, in the order they first appear. */
export function retiredSessions(records) {
    return newestBySession(records).filter(isRetire);
}
function recordOf(record) {
    const base = { [VERSION_FIELD]: HIRE_FORMAT, kind: record.kind, session: record.session, reason: record.reason, by: record.by, at: new Date(record.at).toISOString() };
    if (!isHire(record)) {
        return {
            ...base,
            ...(record.handover === undefined ? {} : { handover: record.handover }),
            ...(record.noHandover === undefined ? {} : { noHandover: record.noHandover }),
            ...(record.heir === undefined ? {} : { heir: record.heir }),
        };
    }
    return {
        ...base,
        scope: record.scope,
        ...(record.approvedBy === undefined ? {} : { approvedBy: record.approvedBy }),
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(record.effort === undefined ? {} : { effort: record.effort }),
        dailyPct: record.dailyPct,
        reviewBy: record.reviewBy,
    };
}
function finitePct(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100;
}
function instantOf(record, key) {
    const text = stringField(record, key);
    const at = text === undefined ? Number.NaN : Date.parse(text);
    return Number.isNaN(at) ? undefined : at;
}
/** One record as a hire or a retire; undefined when it is damaged. */
export function parseHiringRecord(record) {
    const session = stringField(record, 'session');
    const reason = stringField(record, 'reason');
    const by = stringField(record, 'by');
    const at = instantOf(record, 'at');
    if (session === undefined || reason === undefined || by === undefined || at === undefined) {
        return undefined;
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
    const dailyPct = record['dailyPct'];
    const effort = record['effort'];
    const approvedBy = stringField(record, 'approvedBy');
    const model = stringField(record, 'model');
    if (record['kind'] !== 'hire' || scope === undefined || reviewBy === undefined || parseUtcDay(reviewBy) === undefined || !finitePct(dailyPct)) {
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
        dailyPct,
        reviewBy,
        by,
        at,
    };
}
/** The team's append-only log of hires and retires, `<state>/hires.jsonl`, oldest first. */
export class HiringLog {
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
            const parsed = version === HIRE_FORMAT ? parseHiringRecord(record) : undefined;
            if (parsed !== undefined) {
                records.push(parsed);
            }
        }
        return { records, skipped: parse.unreadable + parse.records.length - records.length };
    }
    /** One whole line in one append; refused beside records from a newer teamrig. */
    async append(record) {
        const text = (await this.files.read(this.path)) ?? '';
        assertWritable(this.path, parseJsonl(text), HIRE_FORMAT);
        const separator = text === '' || text.endsWith('\n') ? '' : '\n';
        await this.files.append(this.path, `${separator}${toJsonlLine(recordOf(record))}`);
    }
}
