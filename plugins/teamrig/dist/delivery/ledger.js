import { isStringArray, stringField } from "../core/guards.js";
import { parseJsonl } from "../core/jsonl.js";
import { formatUtcMinute } from "../core/time.js";
/** The ledger's file name in the delivery folder: one JSON record a line, appended. */
export const LEDGER_FILE = 'ledger.jsonl';
/** The people's ledger beside it: one line a deploy, appended. */
export const LEDGER_MD_FILE = 'ledger.md';
/** The first line of a ledger.md teamrig starts. */
export const LEDGER_MD_HEADER = '# Deploy ledger: one line a deploy: deployed at (UTC) | session | repo | range | what | kind | note';
function short(sha) {
    return sha.slice(0, 8);
}
/** The landed commits as the ledger names them: `<first>..<last>` by 8-character sha, or the one commit. */
export function rangeText(commits, fallback) {
    const first = commits[0];
    const last = commits[commits.length - 1];
    if (first === undefined || last === undefined) {
        return short(fallback);
    }
    return first === last ? short(first) : `${short(first)}..${short(last)}`;
}
/** Appends one record as one line, in one write. */
export async function appendRecord(files, ledger, record) {
    await files.append(ledger, `${JSON.stringify(record)}\n`);
}
/** A deploy's ledger.md line, `- <deployed at> | session | repo | range | what | kind | note`; a `|` or line break in a field becomes `/`. */
export function ledgerLine(record) {
    const fields = [record.session, record.repo, record.range, record.what, record.kind, record.note].map((field) => field.replace(/[|\r\n]/g, '/'));
    return `- ${formatUtcMinute(new Date(record.rolledAt))} | ${fields.join(' | ')}`;
}
/** Appends a deploy to the JSON ledger and its line to ledger.md, starting a missing ledger.md with its header. */
export async function appendDeploy(files, places, record) {
    await appendRecord(files, places.ledger, record);
    await files.createExclusive(places.ledgerMd, `${LEDGER_MD_HEADER}\n`);
    await files.append(places.ledgerMd, `${ledgerLine(record)}\n`);
}
/** An ISO time field; undefined when it is missing or no time. */
function timeField(record, key) {
    const value = stringField(record, key);
    return value !== undefined && Number.isFinite(Date.parse(value)) ? value : undefined;
}
/** A whole number of MB; undefined when it is missing or anything else. */
function mbField(record, key) {
    const value = record[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** The optional fields a record carries, each left out when it is missing or bad, since they only add to it. */
function queuedStepExtrasOf(record) {
    const [kit, queuedAt] = [stringField(record, 'kit'), timeField(record, 'queuedAt')];
    const [peakTreeMb, lowFreeMb] = [mbField(record, 'peakTreeMb'), mbField(record, 'lowFreeMb')];
    return {
        ...(kit === undefined ? {} : { kit }),
        ...(queuedAt === undefined ? {} : { queuedAt }),
        ...(record['shared'] === true ? { shared: true } : {}),
        ...(peakTreeMb === undefined ? {} : { peakTreeMb }),
        ...(lowFreeMb === undefined ? {} : { lowFreeMb }),
    };
}
/** An end that may not have come yet: null, else an ISO time; undefined when it is neither. */
function endField(record, key) {
    return record[key] === null ? null : timeField(record, key);
}
function queuedStepOf(record) {
    const [id, session, what] = [stringField(record, 'id'), stringField(record, 'session'), stringField(record, 'what')];
    const [startedAt, endedAt] = [timeField(record, 'startedAt'), endField(record, 'endedAt')];
    const exitCode = record['exitCode'];
    const exit = exitCode === null || (typeof exitCode === 'number' && Number.isInteger(exitCode)) ? exitCode : undefined;
    if (id === undefined || session === undefined || what === undefined || startedAt === undefined || endedAt === undefined || exit === undefined) {
        return undefined;
    }
    return { type: 'heavy', id, session, what, startedAt, endedAt, exitCode: exit, ...queuedStepExtrasOf(record) };
}
function deployOf(record) {
    const kind = record['kind'];
    const [session, repo, range] = [stringField(record, 'session'), stringField(record, 'repo'), stringField(record, 'range')];
    const [what, note] = [stringField(record, 'what'), stringField(record, 'note')];
    const [startedAt, rolledAt] = [timeField(record, 'startedAt'), timeField(record, 'rolledAt')];
    const targets = record['targets'];
    if ((kind !== 'deploy' && kind !== 'rollback') || session === undefined || repo === undefined || range === undefined || what === undefined || note === undefined || startedAt === undefined || rolledAt === undefined) {
        return undefined;
    }
    return { type: 'deploy', kind, session, repo, range, what, note, startedAt, rolledAt, ...(isStringArray(targets) ? { targets } : {}) };
}
function jobOf(record) {
    const [id, session, what] = [stringField(record, 'id'), stringField(record, 'session'), stringField(record, 'what')];
    const [startedAt, endedAt] = [timeField(record, 'startedAt'), endField(record, 'endedAt')];
    const targets = record['targets'];
    const jobTargets = targets === 'host' || isStringArray(targets) ? targets : undefined;
    if (id === undefined || session === undefined || what === undefined || startedAt === undefined || endedAt === undefined || jobTargets === undefined) {
        return undefined;
    }
    return { type: 'load', id, session, what, targets: jobTargets, startedAt, endedAt };
}
const READERS = { heavy: queuedStepOf, deploy: deployOf, load: jobOf };
function isLedgerType(type) {
    return type === 'heavy' || type === 'deploy' || type === 'load';
}
/** The ledger's queued step, deploy and job records, in file order; a damaged line, a record of another type or one with a bad field is left out. */
export function parseLedger(text) {
    return parseJsonl(text).records.flatMap(({ record }) => {
        const type = record['type'];
        const read = isLedgerType(type) ? READERS[type](record) : undefined;
        return read === undefined ? [] : [read];
    });
}
const MD_MINUTE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
/** A ledger.md minute, `YYYY-MM-DD HH:MM` UTC, in ms; undefined for anything else. */
function mdMinute(text) {
    const parts = MD_MINUTE.exec(text);
    if (parts === null) {
        return undefined;
    }
    const time = Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:00Z`);
    return Number.isFinite(time) ? time : undefined;
}
/** The deploys and rollbacks of ledger.md, in file order; the header, other kinds (`start`) and malformed lines are left out. */
export function parseLedgerMd(text) {
    return text.split('\n').flatMap((line) => {
        if (!line.startsWith('- ')) {
            return [];
        }
        const [when = '', session = '', repo = '', , , kind = ''] = line.slice(2).split('|').map((cell) => cell.trim());
        const rolledAt = mdMinute(when);
        if (rolledAt === undefined || session === '' || repo === '' || (kind !== 'deploy' && kind !== 'rollback')) {
            return [];
        }
        return [{ rolledAt, session, repo, kind }];
    });
}
