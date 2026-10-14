import { isRecord } from "../core/guards.js";
import { parseUtcDeadline } from "../core/time.js";
import { isTaskStatus, TASK_ID } from "./model.js";
/**
 * The register's event format. Version 0 lines have no `v`; version 1 adds `"v": 1` and nothing
 * else, so both parse the same way. Parsing checks the FORMAT only (any positive tier, any goal
 * string): team policy is applied on write, so changing the config never erases history.
 */
export const EVENT_VERSION = 1;
export const TASK_FIELD_NAMES = ['title', 'owner', 'source', 'ref', 'tier', 'due', 'goals', 'week'];
const WEEK = /^\d{4}-\d{2}-\d{2}$/;
/** Parses one JSONL record. Unknown extra fields are ignored so later minor additions stay readable. */
export function parseEvent(line) {
    if (line.version > EVENT_VERSION) {
        return { kind: 'newer' };
    }
    const { record } = line;
    const base = parseBase(record, line.version);
    if (typeof base === 'string') {
        return unreadable(base);
    }
    switch (record['type']) {
        case 'create': {
            const task = isRecord(record['task']) ? parseTaskFields(record['task'], true) : 'task is not an object';
            return typeof task === 'string' ? unreadable(task) : { kind: 'event', event: { ...base, type: 'create', task } };
        }
        case 'status': {
            const status = record['status'];
            if (!isTaskStatus(status)) {
                return unreadable(`unknown status ${JSON.stringify(status)}`);
            }
            const problem = textProblem(record, ['note', 'evidence', 'skill']);
            if (problem !== undefined) {
                return unreadable(problem);
            }
            const event = {
                ...base,
                type: 'status',
                status,
                note: textOrNull(record, 'note'),
                evidence: textOrNull(record, 'evidence'),
                skill: textOrNull(record, 'skill'),
            };
            return { kind: 'event', event };
        }
        case 'update': {
            const changes = isRecord(record['changes']) ? parseTaskFields(record['changes'], false) : 'changes is not an object';
            if (typeof changes === 'string') {
                return unreadable(changes);
            }
            const problem = textProblem(record, ['note']);
            if (problem !== undefined) {
                return unreadable(problem);
            }
            return { kind: 'event', event: { ...base, type: 'update', changes, note: textOrNull(record, 'note') } };
        }
        default:
            return unreadable(`unknown event type ${JSON.stringify(record['type'])}`);
    }
}
function unreadable(reason) {
    return { kind: 'unreadable', reason };
}
function parseBase(record, v) {
    const { id, at, by } = record;
    if (typeof id !== 'string' || !TASK_ID.test(id)) {
        return `bad task id ${JSON.stringify(id)}`;
    }
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
        return `bad time ${JSON.stringify(at)}`;
    }
    if (typeof by !== 'string' || by === '') {
        return 'missing author';
    }
    return { v, id, at, by };
}
/** Reads `null`-able text fields; a missing one is null (older lines lack `skill`). */
/** The first of `keys` that is present but neither text nor null. */
function textProblem(record, keys) {
    const bad = keys.find((key) => {
        const value = record[key];
        return value !== undefined && value !== null && typeof value !== 'string';
    });
    return bad === undefined ? undefined : `${bad} is not text`;
}
/** An optional text field: absent and null both read as null. */
function textOrNull(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : null;
}
function parseTaskFields(record, complete) {
    const fields = {};
    for (const name of TASK_FIELD_NAMES) {
        const value = record[name];
        if (value === undefined && !complete) {
            continue;
        }
        const problem = readField(fields, name, value);
        if (problem !== undefined) {
            return problem;
        }
    }
    return fields;
}
function readField(fields, name, value) {
    switch (name) {
        case 'title':
        case 'owner':
        case 'source':
            if (typeof value !== 'string' || value === '') {
                return `${name} is not text`;
            }
            fields[name] = value;
            return undefined;
        case 'ref':
            if (value !== undefined && value !== null && typeof value !== 'string') {
                return 'ref is not text';
            }
            fields.ref = typeof value === 'string' ? value : null;
            return undefined;
        case 'tier':
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
                return `bad tier ${JSON.stringify(value)}`;
            }
            fields.tier = value;
            return undefined;
        case 'due':
            if (value !== undefined && value !== null && (typeof value !== 'string' || parseUtcDeadline(value) === undefined)) {
                return `bad due ${JSON.stringify(value)}`;
            }
            fields.due = typeof value === 'string' ? value : null;
            return undefined;
        case 'week':
            if (value !== undefined && value !== null && (typeof value !== 'string' || !WEEK.test(value))) {
                return `bad week ${JSON.stringify(value)}`;
            }
            fields.week = typeof value === 'string' ? value : null;
            return undefined;
        case 'goals':
            if (value === undefined || value === null) {
                fields.goals = [];
                return undefined;
            }
            if (!Array.isArray(value) || !value.every((goal) => typeof goal === 'string')) {
                return 'goals is not a list of text';
            }
            fields.goals = value;
            return undefined;
    }
}
