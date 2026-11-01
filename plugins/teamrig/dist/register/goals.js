import { parseJsonl } from "../core/jsonl.js";
import { parseUtcDay } from "../core/time.js";
import { SESSION_NAME } from "./model.js";
/**
 * Goal records (T1730, design tasks/T1730/design.md): a goal's tag, title, planned window and target, and each move of
 * its target with the note saying why (a slip), so a goal's progress reads against a plan. They live in their own
 * append-only file beside the register's `events.jsonl`, never in the event log, so a reader that knows only the
 * events never meets a line it cannot read, and a rotation never touches them. Pure: the caller hands in the text it
 * read (the pane vendors this through `read/index`).
 */
/** The goal records' file, beside the register's `events.jsonl`. */
export const GOALS_FILE = 'goals.jsonl';
/** The format version every goal record is written with. */
export const GOAL_RECORD_VERSION = 1;
/** A goal's tag: a letter, then letters, digits, `.` or `-`, at most 24 characters (`A2`, `A2.1`, `B1-a`). */
export const GOAL_TAG = /^[A-Za-z][A-Za-z0-9.-]{0,23}$/;
/** What a task names instead of a goal when it serves none; never a goal's tag. */
export const NO_GOAL = 'none';
export const NO_GOALS = { goals: new Map(), unreadable: 0, newer: 0, ignored: 0 };
/** No goal tags: what a task may name when no goal record is read, as under `register.goals` free. */
export const NO_GOAL_TAGS = new Set();
/** True for a bare `YYYY-MM-DD` that is a real calendar day. */
export function isGoalDay(text) {
    return /^\d{4}-\d{2}-\d{2}$/.test(text) && parseUtcDay(text) !== undefined;
}
function textField(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function dayField(record, key) {
    const value = textField(record, key);
    return value !== undefined && isGoalDay(value) ? value : undefined;
}
/** The fields every record carries, or why the record cannot be read. */
function baseOf(record) {
    const at = textField(record, 'at');
    if (at === undefined || Number.isNaN(Date.parse(at))) {
        return 'at is not a time';
    }
    const by = textField(record, 'by');
    if (by === undefined || !SESSION_NAME.test(by)) {
        return 'by is not a session';
    }
    const tag = textField(record, 'tag');
    if (tag === undefined || !GOAL_TAG.test(tag) || tag === NO_GOAL) {
        return `tag ${JSON.stringify(record['tag'])} is not a goal tag`;
    }
    return { at, by, tag };
}
/** Parses one line of the goals file. Unknown extra fields are ignored, so a later minor addition stays readable. */
export function parseGoalRecord(line) {
    if (line.version > GOAL_RECORD_VERSION) {
        return { kind: 'newer' };
    }
    const { record } = line;
    const base = baseOf(record);
    if (typeof base === 'string') {
        return { kind: 'unreadable', reason: base };
    }
    switch (record['type']) {
        case 'goal-add': {
            const title = textField(record, 'title');
            const start = dayField(record, 'start');
            const target = dayField(record, 'target');
            const parent = record['parent'] ?? null;
            if (title === undefined) {
                return { kind: 'unreadable', reason: 'title is not text' };
            }
            if (start === undefined || target === undefined) {
                return { kind: 'unreadable', reason: 'start or target is not a day' };
            }
            if (parent !== null && (typeof parent !== 'string' || !GOAL_TAG.test(parent))) {
                return { kind: 'unreadable', reason: `parent ${JSON.stringify(parent)} is not a goal tag` };
            }
            return { kind: 'record', record: { type: 'goal-add', ...base, title, start, target, parent } };
        }
        case 'goal-set': {
            const note = textField(record, 'note');
            const target = record['target'] ?? null;
            const title = record['title'] ?? null;
            if (note === undefined) {
                return { kind: 'unreadable', reason: 'note is not text' };
            }
            if (target !== null && (typeof target !== 'string' || !isGoalDay(target))) {
                return { kind: 'unreadable', reason: 'target is not a day' };
            }
            if (title !== null && (typeof title !== 'string' || title.trim() === '')) {
                return { kind: 'unreadable', reason: 'title is not text' };
            }
            return { kind: 'record', record: { type: 'goal-set', ...base, target, title, note } };
        }
        default:
            return { kind: 'unreadable', reason: `unknown type ${JSON.stringify(record['type'])}` };
    }
}
/** A record as its line is written: the version first, and a set's kept fields left out. */
export function goalRecordJson(record) {
    if (record.type === 'goal-add') {
        return { v: GOAL_RECORD_VERSION, ...record };
    }
    const { target, title, ...rest } = record;
    return { v: GOAL_RECORD_VERSION, ...rest, ...(target === null ? {} : { target }), ...(title === null ? {} : { title }) };
}
/** Folds records in write order: a set changes the goal it names; one before its goal's add, or a second add, is ignored. */
export function foldGoals(records) {
    const goals = new Map();
    let ignored = 0;
    for (const record of records) {
        const goal = goals.get(record.tag);
        if (record.type === 'goal-add') {
            if (goal === undefined) {
                const { tag, title, start, target, parent, at, by } = record;
                goals.set(tag, { tag, title, start, target, parent, addedAt: at, addedBy: by, slips: [] });
            }
            else {
                ignored += 1;
            }
            continue;
        }
        if (goal === undefined) {
            ignored += 1;
            continue;
        }
        const slip = record.target !== null && record.target !== goal.target ? { at: record.at, by: record.by, from: goal.target, to: record.target, note: record.note } : undefined;
        goals.set(record.tag, {
            ...goal,
            title: record.title ?? goal.title,
            target: record.target ?? goal.target,
            slips: slip === undefined ? goal.slips : [...goal.slips, slip],
        });
    }
    return { goals, ignored };
}
/** The goals file's text as read (undefined: no file yet), folded. A bad line is counted, never thrown. */
export function readGoals(text) {
    return text === undefined ? NO_GOALS : foldGoalLines(parseJsonl(text));
}
/** The goals file's parsed lines, folded; a writer parses once to check the versions and fold the same lines. */
export function foldGoalLines(parsed) {
    const records = [];
    let unreadable = parsed.unreadable;
    let newer = 0;
    for (const line of parsed.records) {
        const result = parseGoalRecord(line);
        if (result.kind === 'record') {
            records.push(result.record);
        }
        else if (result.kind === 'newer') {
            newer += 1;
        }
        else {
            unreadable += 1;
        }
    }
    const { goals, ignored } = foldGoals(records);
    return { goals, unreadable, newer, ignored };
}
function tagRefusal(tag) {
    if (tag === NO_GOAL) {
        return `"${NO_GOAL}" is what a task names when it serves no goal, never a goal's tag`;
    }
    return GOAL_TAG.test(tag) ? undefined : `"${tag}" is not a goal tag: a letter, then letters, digits, . or -, at most 24 characters`;
}
/** Why `goal add` cannot write its record over `goals`; undefined when it can. */
export function goalAddRefusal(input, goals) {
    const badTag = tagRefusal(input.tag);
    if (badTag !== undefined) {
        return badTag;
    }
    if (goals.has(input.tag)) {
        return `goal ${input.tag} already exists; move its target with goal set`;
    }
    if (input.title.trim() === '') {
        return 'a goal has a title';
    }
    if (!isGoalDay(input.start) || !isGoalDay(input.target)) {
        return '--start and --target are YYYY-MM-DD days';
    }
    if (input.start > input.target) {
        return `--start ${input.start} is after --target ${input.target}`;
    }
    if (input.parent !== null && !goals.has(input.parent)) {
        return `--parent ${input.parent} is not a goal; add it first`;
    }
    return undefined;
}
/** Why `goal set` cannot write its record over `goals`; undefined when it can. */
export function goalSetRefusal(input, goals) {
    const goal = goals.get(input.tag);
    if (goal === undefined) {
        return `goal ${input.tag} does not exist; add it with goal add`;
    }
    if (input.target === null && input.title === null) {
        return 'goal set changes --target, --title or both';
    }
    if (input.note.trim() === '') {
        return 'goal set says why in --note';
    }
    if (input.target !== null && !isGoalDay(input.target)) {
        return '--target is a YYYY-MM-DD day';
    }
    if (input.target !== null && input.target < goal.start) {
        return `--target ${input.target} is before the goal's start ${goal.start}`;
    }
    if (input.title !== null && input.title.trim() === '') {
        return 'a goal has a title';
    }
    if ((input.target ?? goal.target) === goal.target && (input.title ?? goal.title) === goal.title) {
        return `goal ${input.tag} already reads so; nothing to change`;
    }
    return undefined;
}
