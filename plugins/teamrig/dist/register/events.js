import { isRecord } from "../core/guards.js";
import { ID_PATTERN } from "../core/ids.js";
import { parseUtcDeadline } from "../core/time.js";
import { isTaskStatus, LEGACY_WAITING_STATUS, TASK_ID, WAIT_STATUSES, WORK_CLASS_NAME } from "./model.js";
import { parseCard } from "./card.js";
import { parseReview } from "./review.js";
import { parseWaits } from "./waits.js";
/**
 * The register's event format. Version 0 lines have no `v`; version 1 adds `"v": 1` and nothing
 * else; version 2 names the task field `priority` where older lines wrote `tier`. All three parse
 * the same way: an old line's `tier` reads as its priority and the line is never rewritten.
 * Version 2 later gained, without a new number, a task's `after` list and the `waiting` status with its
 * `waits`, which replaced `blocked`: an older reader ignores the new fields and skips a `waiting` line as
 * a newer teamrig's, and a `blocked` line reads here as `waiting` with no reasons. It also gained a
 * `verifying` status's `proof`, a task's `description` (0.44.0) and its `size` (0.47.0), and a `waiting` status's
 * decision `card` (0.79.0), the same `waits` and `card` on a `verifying` line for what its proof waits for
 * (0.109.0), an update's approval `verdict` (0.126.0), a task's `kind` (0.147.0), its `pin` (T637), a status line's
 * `review` (T916), a task's `type` and `critical` mark (T1252), which replaced `kind`, and a `done` status's `watch`
 * (T1306), an update's `waits` (T1295), a task's `noGoal` mark (T1730), an update's `decided` mark (T1366) and its
 * `sizeBase` (T649) and a task's `workClass` (T2076), which an older reader ignores:
 * each reads there as none (an answered update as a note alone). An older teamrig re-serialized the events of the snapshot a rotation or
 * `compact` rewrites, so it dropped such a field there (the archive keeps the lines as written); this one copies
 * each kept line as written (compaction.ts).
 * Version 3 adds the `moved` record (T1144), and only a moved line carries it: an older teamrig reads that line as a
 * newer format and writes to the register no more, so no session of it changes a task that moved to another team.
 * Parsing checks the FORMAT only (any priority from 0, any goal string): team policy is applied
 * on write, so changing the config never erases history.
 */
export const EVENT_VERSION = 3;
/** The version every line but a moved one is written with, so a reader of version 2 reads them all. */
export const TASK_LINE_VERSION = 2;
/** The name lines before version 2 gave the `priority` field; still read, never written. */
export const LEGACY_PRIORITY_FIELD = 'tier';
/**
 * What a register item is (`--type`): a `task`, the default, or a `bug`, such as a fix, an incident, the investigation
 * of a failure, a bug's design or the decision about one. What each type does is its row in item-types.ts.
 */
export const ITEM_TYPES = ['task', 'bug'];
export function isItemType(value) {
    return ITEM_TYPES.some((type) => type === value);
}
/** How a type is spelled (`bug`): a well-spelled one this code does not know is a newer teamrig's, read as a task. */
const TYPE_NAME = /^[a-z]+(?:-[a-z]+)*$/;
/** The field lines before T1252 marked a task with (`work`, `problem` or `critical`); read as a type and critical mark, never written. */
export const LEGACY_KIND_FIELD = 'kind';
/** What each `kind` an older line wrote reads as. */
const LEGACY_KINDS = new Map([
    ['work', { type: 'task', critical: false }],
    ['problem', { type: 'bug', critical: false }],
    ['critical', { type: 'bug', critical: true }],
]);
export const TASK_FIELD_NAMES = ['title', 'description', 'owner', 'source', 'ref', 'priority', 'due', 'goals', 'noGoal', 'week', 'after', 'size', 'type', 'critical', 'pin', 'workClass'];
/** The lead's answer to the approval a waiting task asks of it (T684): given, or declined with the note saying why. */
export const APPROVAL_VERDICTS = ['approved', 'declined'];
export function isApprovalVerdict(value) {
    return APPROVAL_VERDICTS.some((verdict) => verdict === value);
}
/** The size base a line gives, or why it is not one. */
function parseSizeBase(value) {
    if (!isRecord(value)) {
        return 'sizeBase is not an object';
    }
    const { day, w } = value;
    if (typeof day !== 'string' || !WEEK.test(day) || typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
        return `bad sizeBase ${JSON.stringify(value)}`;
    }
    return { day, w };
}
const WEEK = /^\d{4}-\d{2}-\d{2}$/;
/** The largest size a task can have: the whole weekly limit. */
export const MAX_SIZE_PCT = 100;
/** Why `value` is not a size, or undefined: a size is a finite number above 0 and at most MAX_SIZE_PCT. */
export function sizeProblem(value) {
    return Number.isFinite(value) && value > 0 && value <= MAX_SIZE_PCT ? undefined : `size ${value} is not above 0 and at most ${MAX_SIZE_PCT}`;
}
/** How a status is spelled (`in-progress`): a well-spelled one this code does not know is a newer teamrig's. */
const STATUS_NAME = /^[a-z]+(?:-[a-z]+)*$/;
/**
 * The record an event is written as. A create line leaves out an empty `after`, a null `description`, `size`, `type`,
 * `pin` or `workClass` and a false `critical` or `noGoal`, which read back as none, so a task without them costs no bytes and its
 * line is the one an older teamrig wrote.
 */
export function eventRecord(event) {
    if (event.type !== 'create') {
        return { ...event };
    }
    const { task } = event;
    const left = (name) => (name === 'after' && task.after.length === 0) ||
        (name === 'description' && task.description === null) ||
        (name === 'size' && task.size === null) ||
        (name === 'type' && task.type === null) ||
        (name === 'critical' && !task.critical) ||
        (name === 'noGoal' && !task.noGoal) ||
        (name === 'pin' && task.pin === null) ||
        (name === 'workClass' && task.workClass === null);
    return { ...event, task: Object.fromEntries(Object.entries(task).filter(([name]) => !left(name))) };
}
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
            const status = record['status'] === LEGACY_WAITING_STATUS ? 'waiting' : record['status'];
            if (!isTaskStatus(status)) {
                return typeof status === 'string' && STATUS_NAME.test(status) ? { kind: 'newer' } : unreadable(`unknown status ${JSON.stringify(status)}`);
            }
            const problem = textProblem(record, ['note', 'evidence', 'skill', 'proof', 'watch', 'met']);
            if (problem !== undefined) {
                return unreadable(problem);
            }
            const waits = WAIT_STATUSES.includes(status) && record['waits'] !== undefined ? parseWaits(record['waits']) : undefined;
            if (typeof waits === 'string') {
                return unreadable(waits);
            }
            const card = WAIT_STATUSES.includes(status) ? parseCard(record['card']) : undefined;
            if (typeof card === 'string') {
                return unreadable(card);
            }
            const proof = status === 'verifying' ? textOrNull(record, 'proof') : null;
            const watch = status === 'done' ? textOrNull(record, 'watch') : null;
            const met = status === 'in-progress' ? textOrNull(record, 'met') : null;
            const followups = parseFollowups(record['followups']);
            if (typeof followups === 'string') {
                return unreadable(followups);
            }
            const review = parseReview(record['review']);
            if (typeof review === 'string') {
                return unreadable(review);
            }
            const event = {
                ...base,
                type: 'status',
                status,
                note: textOrNull(record, 'note'),
                evidence: textOrNull(record, 'evidence'),
                skill: textOrNull(record, 'skill'),
                ...(waits === undefined ? {} : { waits }),
                ...(card === undefined ? {} : { card }),
                ...(proof === null ? {} : { proof }),
                ...(watch === null ? {} : { watch }),
                ...(met === null ? {} : { met }),
                ...(followups === undefined ? {} : { followups }),
                ...(review === undefined ? {} : { review }),
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
            const verdict = record['verdict'];
            if (verdict !== undefined && !isApprovalVerdict(verdict)) {
                return unreadable(`unknown approval verdict ${JSON.stringify(verdict)}`);
            }
            const waits = record['waits'] === undefined ? undefined : parseWaits(record['waits']);
            if (typeof waits === 'string') {
                return unreadable(waits);
            }
            const decided = record['decided'];
            if (decided !== undefined && decided !== true) {
                return unreadable(`decided is ${JSON.stringify(decided)}, not true`);
            }
            const sizeBase = record['sizeBase'] === undefined ? undefined : parseSizeBase(record['sizeBase']);
            if (typeof sizeBase === 'string') {
                return unreadable(sizeBase);
            }
            const event = {
                ...base,
                type: 'update',
                changes,
                note: textOrNull(record, 'note'),
                ...(verdict === undefined ? {} : { verdict }),
                ...(waits === undefined ? {} : { waits }),
                ...(decided === undefined ? {} : { decided }),
                ...(sizeBase === undefined ? {} : { sizeBase }),
            };
            return { kind: 'event', event };
        }
        case 'moved': {
            const to = record['to'];
            return typeof to === 'string' && ID_PATTERN.test(to) ? { kind: 'event', event: { ...base, type: 'moved', to } } : unreadable(`bad team ${JSON.stringify(to)}`);
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
/** The first of `keys` that is present but neither text nor null. */
function textProblem(record, keys) {
    const bad = keys.find((key) => {
        const value = record[key];
        return value !== undefined && value !== null && typeof value !== 'string';
    });
    return bad === undefined ? undefined : `${bad} is not text`;
}
/** A status line's follow-ups: undefined when absent or null, else a list of task ids, or the reason it is not one. */
function parseFollowups(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    return Array.isArray(value) && value.every((id) => typeof id === 'string' && TASK_ID.test(id)) ? value : 'followups is not a list of task ids';
}
/** An optional text field: absent and null both read as null. */
function textOrNull(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : null;
}
function parseTaskFields(record, complete) {
    const legacy = legacyMarkOf(record);
    if (typeof legacy === 'string') {
        return legacy;
    }
    const fields = {};
    for (const name of TASK_FIELD_NAMES) {
        const value = fieldValue(record, name, legacy);
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
/** The value a line gives field `name`, reading a field an older line spelled another way (`tier`, `kind`) as its new one. */
function fieldValue(record, name, legacy) {
    if (name === 'priority') {
        return priorityOf(record);
    }
    if ((name === 'type' || name === 'critical') && !(name in record) && legacy !== undefined) {
        return legacy[name];
    }
    return record[name];
}
/** The line's priority: `priority`, else the `tier` of a line written before version 2; `priority` wins when a line has both. */
function priorityOf(record) {
    return 'priority' in record ? record['priority'] : record[LEGACY_PRIORITY_FIELD];
}
/**
 * The type and critical mark a line from before T1252 gave as its `kind`: undefined when it has none, a null `kind`
 * as not set; a `type` or `critical` on the same line wins over it.
 */
function legacyMarkOf(record) {
    const kind = record[LEGACY_KIND_FIELD];
    if (kind === undefined) {
        return undefined;
    }
    return kind === null ? { type: null, critical: false } : (LEGACY_KINDS.get(kind) ?? `bad kind ${JSON.stringify(kind)}`);
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
        case 'description':
            if (value !== undefined && value !== null && typeof value !== 'string') {
                return `${name} is not text`;
            }
            fields[name] = typeof value === 'string' ? value : null;
            return undefined;
        case 'priority':
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
                return `bad priority ${JSON.stringify(value)}`;
            }
            fields.priority = value;
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
        case 'noGoal':
            if (value !== undefined && value !== null && typeof value !== 'boolean') {
                return `bad noGoal ${JSON.stringify(value)}`;
            }
            fields.noGoal = value === true;
            return undefined;
        case 'after':
            if (value === undefined || value === null) {
                fields.after = [];
                return undefined;
            }
            if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && TASK_ID.test(id))) {
                return 'after is not a list of task ids';
            }
            fields.after = value;
            return undefined;
        case 'size':
            if (value === undefined || value === null) {
                fields.size = null;
                return undefined;
            }
            if (typeof value !== 'number' || sizeProblem(value) !== undefined) {
                return `bad size ${JSON.stringify(value)}`;
            }
            fields.size = value;
            return undefined;
        case 'type':
            if (value !== undefined && value !== null && (typeof value !== 'string' || !TYPE_NAME.test(value))) {
                return `bad type ${JSON.stringify(value)}`;
            }
            fields.type = typeof value !== 'string' ? null : isItemType(value) ? value : 'task';
            return undefined;
        case 'critical':
            if (value !== undefined && value !== null && typeof value !== 'boolean') {
                return `bad critical ${JSON.stringify(value)}`;
            }
            fields.critical = value === true;
            return undefined;
        case 'pin':
            if (value !== undefined && value !== null && (typeof value !== 'string' || value === '')) {
                return 'pin is not text';
            }
            fields.pin = typeof value === 'string' ? value : null;
            return undefined;
        case 'workClass':
            if (value !== undefined && value !== null && (typeof value !== 'string' || !WORK_CLASS_NAME.test(value))) {
                return `bad workClass ${JSON.stringify(value)}`;
            }
            fields.workClass = typeof value === 'string' ? value : null;
            return undefined;
    }
}
