import { isRecord, isStringArray, stringField } from "../core/guards.js";
import { parseJsonl } from "../core/jsonl.js";
import { formatUtcMinute } from "../core/time.js";
import { TASK_ID } from "../register/model.js";
import { isStepKind } from "./process-request.js";
import { WAIT_CAUSES } from "./wait-log.js";
/** The ledger's file name in the delivery folder: one JSON record a line, appended. */
export const LEDGER_FILE = 'ledger.jsonl';
/** The people's ledger beside it: one line a deploy, appended. */
export const LEDGER_MD_FILE = 'ledger.md';
/** The first line of a ledger.md teamrig starts. */
export const LEDGER_MD_HEADER = '# Deploy ledger: one line a deploy: deployed at (UTC) | session | repo | range | what | kind | note';
/** The memory fields a queued step's records may carry, each a whole number of MB. */
const STEP_MEMORY_FIELDS = ['queueFreeMb', 'peakTreeMb', 'lowFreeMb', 'startFreeMb', 'endFreeMb', 'commitMb', 'commitLimitMb'];
/**
 * How a queued step that waited ended without running: its wait ran out (`timedOut`), its ticket was withdrawn
 * (`teamrig withdraw`), the shell that started it ended (`stopped`), or it was refused at its turn (`refused`: the queue
 * cutoff, a blackout or a deploy check).
 */
export const REFUSAL_OUTCOMES = ['timedOut', 'withdrawn', 'stopped', 'refused'];
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
/** A whole number at least 0, of MB or ms; undefined when it is missing or anything else. */
function wholeField(record, key) {
    const value = record[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** A step's waits by cause: each known cause with a whole positive number of ms; undefined when none is. */
function waitsField(record) {
    const value = record['waits'];
    if (!isRecord(value)) {
        return undefined;
    }
    const waits = {};
    for (const cause of WAIT_CAUSES) {
        const ms = wholeField(value, cause);
        if (ms !== undefined && ms > 0) {
            waits[cause] = ms;
        }
    }
    return Object.keys(waits).length === 0 ? undefined : waits;
}
/**
 * A step's request as its record names it: a known kind, a register task id and that task's priority (a whole number),
 * each left out when it is missing or bad, and the priority also without its task.
 */
function requestFieldsOf(record) {
    const [kind, text, priority] = [record['kind'], stringField(record, 'task'), wholeField(record, 'priority')];
    const task = text !== undefined && TASK_ID.test(text) ? text : undefined;
    return {
        ...(isStepKind(kind) ? { kind } : {}),
        ...(task === undefined ? {} : { task }),
        ...(task === undefined || priority === undefined ? {} : { priority }),
    };
}
/** The optional fields a record carries, each left out when it is missing or bad, since they only add to it. */
function queuedStepExtrasOf(record) {
    const [kit, queuedAt, waits] = [stringField(record, 'kit'), timeField(record, 'queuedAt'), waitsField(record)];
    const memory = {};
    for (const field of STEP_MEMORY_FIELDS) {
        const mb = wholeField(record, field);
        if (mb !== undefined) {
            memory[field] = mb;
        }
    }
    return {
        ...requestFieldsOf(record),
        ...(kit === undefined ? {} : { kit }),
        ...(queuedAt === undefined ? {} : { queuedAt }),
        ...(waits === undefined ? {} : { waits }),
        ...(record['shared'] === true ? { shared: true } : {}),
        ...memory,
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
function isWaitCause(value) {
    return WAIT_CAUSES.some((cause) => cause === value);
}
function isRefusalOutcome(value) {
    return REFUSAL_OUTCOMES.some((outcome) => outcome === value);
}
/** A wait's reason as a refusal names it: a known cause and its line; undefined when it is anything else. */
function toldField(record, key) {
    const value = record[key];
    if (!isRecord(value)) {
        return undefined;
    }
    const [cause, text] = [value['cause'], stringField(value, 'text')];
    return isWaitCause(cause) && text !== undefined ? { cause, text } : undefined;
}
function refusalOf(record) {
    const [id, session, what, reason] = [stringField(record, 'id'), stringField(record, 'session'), stringField(record, 'what'), stringField(record, 'reason')];
    const [queuedAt, endedAt, outcome, lastWait] = [timeField(record, 'queuedAt'), timeField(record, 'endedAt'), record['outcome'], toldField(record, 'lastWait')];
    if (id === undefined || session === undefined || what === undefined || reason === undefined || queuedAt === undefined || endedAt === undefined || !isRefusalOutcome(outcome) || lastWait === undefined) {
        return undefined;
    }
    const [kit, waits, queueFreeMb, endFreeMb] = [stringField(record, 'kit'), waitsField(record), wholeField(record, 'queueFreeMb'), wholeField(record, 'endFreeMb')];
    return {
        type: 'refusal',
        id,
        session,
        what,
        ...requestFieldsOf(record),
        ...(kit === undefined ? {} : { kit }),
        queuedAt,
        endedAt,
        outcome,
        reason,
        ...(waits === undefined ? {} : { waits }),
        lastWait,
        ...(queueFreeMb === undefined ? {} : { queueFreeMb }),
        ...(endFreeMb === undefined ? {} : { endFreeMb }),
    };
}
const READERS = { heavy: queuedStepOf, deploy: deployOf, load: jobOf, refusal: refusalOf };
function isLedgerType(type) {
    return type === 'heavy' || type === 'deploy' || type === 'load' || type === 'refusal';
}
/** The ledger's queued step, deploy, job and refusal records, in file order; a damaged line, a record of another type or one with a bad field is left out. */
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
