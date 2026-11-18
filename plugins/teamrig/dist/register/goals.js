import { isStringArray } from "../core/guards.js";
import { parseJsonl } from "../core/jsonl.js";
import { parseUtcDay } from "../core/time.js";
import { SESSION_NAME, TASK_ID } from "./model.js";
/**
 * Goal records (T1730): a goal's tag, title, planned window and target, each move of its target with the note saying
 * why (a slip), and its rank among the team's goals (T2083), so a goal's progress reads against a plan and goal-first
 * ranking knows which goal comes first. They live in their own
 * append-only file beside the register's `events.jsonl`, never in the event log, so a reader that knows only the
 * events never meets a line it cannot read, and a rotation never touches them. Pure: the caller hands in the text it
 * read (the pane vendors this through `read/index`).
 */
/** The goal records' file, beside the register's `events.jsonl`. */
export const GOALS_FILE = 'goals.jsonl';
/**
 * The newest format of a goal record this teamrig reads and writes: 2 added the rank record (T2083), 3 a set's open
 * `slice` (T2453), 4 the slice record (T2203). Each record is
 * written with the oldest format that holds it, so an older teamrig still reads every goal's add and set; it counts a
 * rank record as one from a newer teamrig and refuses to write beside it, never folding the goals without their ranks.
 */
export const GOAL_RECORD_VERSION = 4;
/** The format a rank record is written with. */
const GOAL_RANK_VERSION = 2;
/** The format a slice record is written with. */
const GOAL_SLICE_VERSION = 4;
/** The most a slice may cost, as a task's size: the whole weekly limit, in percent. */
const MAX_SLICE_SIZE_PCT = 100;
/** The format a goal's add, and a set without a slice, are written with: they are unchanged since format 1. */
const GOAL_ADD_SET_VERSION = 1;
/** The format a set naming a slice is written with: unchanged since format 3, so a teamrig that reads 3 still writes beside it. */
const GOAL_SET_SLICE_VERSION = 3;
/** The lowest rank, the first goal, and the highest a goal may take. */
export const FIRST_GOAL_RANK = 1;
export const MAX_GOAL_RANK = 99;
/** The first slice of a goal (T2453): slices count from 1. */
export const FIRST_SLICE = 1;
/** True for a slice a goal may have open: a whole number from FIRST_SLICE. */
export function isSlice(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= FIRST_SLICE;
}
/** True for a rank a goal may take: a whole number from FIRST_GOAL_RANK to MAX_GOAL_RANK. */
export function isGoalRank(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= FIRST_GOAL_RANK && value <= MAX_GOAL_RANK;
}
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
            const slice = record['slice'] ?? null;
            if (note === undefined) {
                return { kind: 'unreadable', reason: 'note is not text' };
            }
            if (target !== null && (typeof target !== 'string' || !isGoalDay(target))) {
                return { kind: 'unreadable', reason: 'target is not a day' };
            }
            if (title !== null && (typeof title !== 'string' || title.trim() === '')) {
                return { kind: 'unreadable', reason: 'title is not text' };
            }
            if (slice !== null && !isSlice(slice)) {
                return { kind: 'unreadable', reason: `slice ${JSON.stringify(slice)} is not a whole number from ${FIRST_SLICE}` };
            }
            return { kind: 'record', record: { type: 'goal-set', ...base, target, title, slice, note } };
        }
        case 'goal-rank': {
            const rank = record['rank'] ?? null;
            if (rank !== null && !isGoalRank(rank)) {
                return { kind: 'unreadable', reason: `rank ${JSON.stringify(rank)} is not a whole number from ${FIRST_GOAL_RANK} to ${MAX_GOAL_RANK}` };
            }
            return { kind: 'record', record: { type: 'goal-rank', ...base, rank } };
        }
        case 'goal-slice': {
            const fields = sliceFieldsOf(record);
            return typeof fields === 'string' ? { kind: 'unreadable', reason: fields } : { kind: 'record', record: { type: 'goal-slice', ...base, ...fields } };
        }
        default:
            return { kind: 'unreadable', reason: `unknown type ${JSON.stringify(record['type'])}` };
    }
}
/** A field that is absent (null) or non-empty text; undefined when it is neither. */
function nullableText(record, key) {
    const value = record[key] ?? null;
    return value === null || (typeof value === 'string' && value.trim() !== '') ? value : undefined;
}
/** A field that is absent (null) or a list of task ids; undefined when it is neither. */
function nullableTaskIds(record, key) {
    const value = record[key] ?? null;
    if (value === null) {
        return null;
    }
    return isStringArray(value) && value.every((id) => TASK_ID.test(id)) ? value : undefined;
}
/** A field that is absent (null) or a size above 0 and at most the whole week; undefined when it is neither. */
function nullableSize(record, key) {
    const value = record[key] ?? null;
    return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_SLICE_SIZE_PCT) ? value : undefined;
}
/** A slice record's own fields, or why they cannot be read. */
function sliceFieldsOf(record) {
    const slice = record['slice'];
    const note = textField(record, 'note');
    const [title, proof, proven, owner, ship] = [
        nullableText(record, 'title'),
        nullableText(record, 'proof'),
        nullableText(record, 'proven'),
        nullableText(record, 'owner'),
        nullableText(record, 'ship'),
    ];
    const tasks = nullableTaskIds(record, 'tasks');
    const size = nullableSize(record, 'size');
    if (!isSlice(slice)) {
        return `slice ${JSON.stringify(slice)} is not a whole number from ${FIRST_SLICE}`;
    }
    if (note === undefined) {
        return 'note is not text';
    }
    if (title === undefined || proof === undefined || proven === undefined) {
        return 'title, proof or proven is not text';
    }
    if (owner === undefined || (owner !== null && !SESSION_NAME.test(owner))) {
        return 'owner is not a session';
    }
    if (ship === undefined || (ship !== null && !isGoalDay(ship))) {
        return 'ship is not a day';
    }
    if (tasks === undefined) {
        return 'tasks is not a list of task ids';
    }
    if (size === undefined) {
        return `size is not above 0 and at most ${MAX_SLICE_SIZE_PCT}`;
    }
    return { slice, title, owner, ship, proof, tasks, size, proven, note };
}
/** A slice record as its line is written: its kept fields left out. */
function sliceRecordJson(record) {
    const { title, owner, ship, proof, tasks, size, proven, note, ...rest } = record;
    return {
        v: GOAL_SLICE_VERSION,
        ...rest,
        ...(title === null ? {} : { title }),
        ...(owner === null ? {} : { owner }),
        ...(ship === null ? {} : { ship }),
        ...(proof === null ? {} : { proof }),
        ...(tasks === null ? {} : { tasks }),
        ...(size === null ? {} : { size }),
        ...(proven === null ? {} : { proven }),
        note,
    };
}
/** A record as its line is written: the oldest format that holds it first, and a set's kept fields left out. */
export function goalRecordJson(record) {
    switch (record.type) {
        case 'goal-add':
            return { v: GOAL_ADD_SET_VERSION, ...record };
        case 'goal-rank':
            return { v: GOAL_RANK_VERSION, ...record };
        case 'goal-slice':
            return sliceRecordJson(record);
        case 'goal-set': {
            const { target, title, slice, ...rest } = record;
            const v = slice === null ? GOAL_ADD_SET_VERSION : GOAL_SET_SLICE_VERSION;
            return { v, ...rest, ...(target === null ? {} : { target }), ...(title === null ? {} : { title }), ...(slice === null ? {} : { slice }) };
        }
    }
}
/** The goal a set or a rank record leaves: a set's new title, target (a target move is a slip) and slice, a rank's rank. */
function changedGoal(goal, record) {
    if (record.type === 'goal-rank') {
        return { ...goal, rank: record.rank };
    }
    const slip = record.target !== null && record.target !== goal.target ? { at: record.at, by: record.by, from: goal.target, to: record.target, note: record.note } : undefined;
    return {
        ...goal,
        title: record.title ?? goal.title,
        target: record.target ?? goal.target,
        slice: record.slice ?? goal.slice,
        slips: slip === undefined ? goal.slips : [...goal.slips, slip],
    };
}
/** A slice's first record as a slice; undefined when it lacks a field a new slice names. */
function newSlice(record) {
    const { title, owner, ship, proof, tasks } = record;
    if (title === null || owner === null || ship === null || proof === null || tasks === null) {
        return undefined;
    }
    const proven = record.proven === null ? null : { at: record.at, by: record.by, evidence: record.proven };
    return { number: record.slice, title, owner, ship, proof, tasks, size: record.size, proven, slips: [], addedAt: record.at, addedBy: record.by };
}
/** The slice a later record leaves: the fields it names, its first proof kept, a ship day move as a slip. */
function changedSlice(slice, record) {
    const slip = record.ship !== null && record.ship !== slice.ship ? { at: record.at, by: record.by, from: slice.ship, to: record.ship, note: record.note } : undefined;
    const proven = slice.proven ?? (record.proven === null ? null : { at: record.at, by: record.by, evidence: record.proven });
    return {
        ...slice,
        title: record.title ?? slice.title,
        owner: record.owner ?? slice.owner,
        ship: record.ship ?? slice.ship,
        proof: record.proof ?? slice.proof,
        tasks: record.tasks ?? slice.tasks,
        size: record.size ?? slice.size,
        proven,
        slips: slip === undefined ? slice.slips : [...slice.slips, slip],
    };
}
/** The goal a slice record leaves; undefined when it opens a slice without the fields a new one names. */
function slicedGoal(goal, record) {
    const known = goal.slices.find((slice) => slice.number === record.slice);
    const slice = known === undefined ? newSlice(record) : changedSlice(known, record);
    if (slice === undefined) {
        return undefined;
    }
    const slices = [...goal.slices.filter((each) => each.number !== record.slice), slice].sort((a, b) => a.number - b.number);
    return { ...goal, slices };
}
/**
 * Folds records in write order: a set, rank or slice record changes the goal it names; one before its goal's add, a
 * second add, or a slice's first record lacking a field a new slice names, is ignored.
 */
export function foldGoals(records) {
    const goals = new Map();
    let ignored = 0;
    for (const record of records) {
        const goal = goals.get(record.tag);
        if (record.type === 'goal-add') {
            if (goal === undefined) {
                const { tag, title, start, target, parent, at, by } = record;
                goals.set(tag, { tag, title, start, target, parent, addedAt: at, addedBy: by, slips: [], rank: null, slice: null, slices: [] });
            }
            else {
                ignored += 1;
            }
            continue;
        }
        const changed = goal === undefined ? undefined : record.type === 'goal-slice' ? slicedGoal(goal, record) : changedGoal(goal, record);
        if (changed === undefined) {
            ignored += 1;
            continue;
        }
        goals.set(record.tag, changed);
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
/** The key results (goals with a parent) whose target is `today` or later. */
export function openKeyResults(goals, today) {
    return [...goals.values()].filter((goal) => goal.parent !== null && goal.target >= today);
}
function tagRefusal(tag) {
    if (tag === NO_GOAL) {
        return `"${NO_GOAL}" is what a task names when it serves no goal, never a goal's tag`;
    }
    return GOAL_TAG.test(tag) ? undefined : `"${tag}" is not a goal tag: a letter, then letters, digits, . or -, at most 24 characters`;
}
/** Why `goal add` cannot write its record over `goals`, a key result past `cap` among them; undefined when it can. */
export function goalAddRefusal(input, goals, cap) {
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
    return input.parent === null ? undefined : keyResultRefusal(goals, cap);
}
/** Why one more key result would pass `cap`; undefined while it would not. */
function keyResultRefusal(goals, cap) {
    const open = openKeyResults(goals, cap.today).length;
    if (open < cap.max) {
        return undefined;
    }
    return `the team holds ${open} key results (goals with a parent) with a target of ${cap.today} or later, the most focus.maxActiveKeyResults allows: finish one or move its target first`;
}
/** Why `goal rank` cannot write its record over `goals`; undefined when it can. */
export function goalRankRefusal(input, goals) {
    const goal = goals.get(input.tag);
    if (goal === undefined) {
        return `goal ${input.tag} does not exist; add it with goal add`;
    }
    if (input.rank !== null && !isGoalRank(input.rank)) {
        return `a rank is a whole number from ${FIRST_GOAL_RANK} to ${MAX_GOAL_RANK}, or none`;
    }
    if (input.rank === goal.rank) {
        return input.rank === null ? `goal ${input.tag} is not ranked; nothing to change` : `goal ${input.tag} already ranks ${input.rank}; nothing to change`;
    }
    return undefined;
}
/** Why `goal set` cannot write its record over `goals`; undefined when it can. */
export function goalSetRefusal(input, goals) {
    const goal = goals.get(input.tag);
    if (goal === undefined) {
        return `goal ${input.tag} does not exist; add it with goal add`;
    }
    if (input.target === null && input.title === null && input.slice === null) {
        return 'goal set changes --target, --title, --slice or more';
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
    if (input.slice !== null && !isSlice(input.slice)) {
        return `--slice is a whole number from ${FIRST_SLICE}`;
    }
    if ((input.target ?? goal.target) === goal.target && (input.title ?? goal.title) === goal.title && (input.slice ?? goal.slice) === goal.slice) {
        return `goal ${input.tag} already reads so; nothing to change`;
    }
    return undefined;
}
