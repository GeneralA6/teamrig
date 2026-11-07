import { isRecord, numberField, stringField } from "../core/guards.js";
import { parseObject, recordVersion, VERSION_FIELD } from "../core/jsonl.js";
import { parseUtcDay } from "../core/time.js";
/**
 * The team's usage rollup: what each session spent in a closed UTC day, by what the use was for, written once a day by
 * `teamrig budget rollup` for a reader that needs the split without reading transcripts, as `teamrig stats` and the
 * pane. One file per team and day, at `ROLLUP_IN_STATE` under the team's state folder, named `<day>.json`. It holds
 * numbers and ids only, no text of a transcript, and no time of its run, so a rewrite of a day gives the same file; the
 * format, one JSON object:
 *
 * - `v`: `ROLLUP_FORMAT`;
 * - `day`: the UTC day, `YYYY-MM-DD`;
 * - `team`: the team's id;
 * - `rows`: per session, class, model and effort: `w` (raw, before `budget.subagentWeight`), the four token counts,
 *   `turns`, `calls` and `seconds`;
 * - `tasks`: per session and task, a null task for a turn that named none: `w` and `seconds` of task work only, so
 *   coordination stays its own class and the `w` here adds up to the rows of `work`, `lead-work` and `helper`.
 */
export const ROLLUP_IN_STATE = ['usage', 'rollup'];
/** The rollup's format; a field added to it raises this. */
export const ROLLUP_FORMAT = 1;
export const USE_CLASSES = ['coordination-turn', 'coordination-call', 'lead-coordination', 'lead-work', 'work', 'helper'];
const ROLLUP_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The file a team's rollup of `day` sits in, under the team's rollup folder. */
export function rollupFileName(day) {
    return `${day}.json`;
}
/** The day a name in the rollup folder holds; undefined for any other file. */
export function rollupDayOf(name) {
    const day = name.slice(0, -rollupFileName('').length);
    return name === rollupFileName(day) && parseUtcDay(day) !== undefined ? day : undefined;
}
/** The rollup as its file's text. */
export function formatRollup(rollup) {
    const { day, team, rows, tasks } = rollup;
    return JSON.stringify({ [VERSION_FIELD]: ROLLUP_FORMAT, day, team, rows, tasks });
}
function isUseClass(value) {
    return USE_CLASSES.some((useClass) => useClass === value);
}
/** A field that holds a text or null; undefined when it holds neither. */
function textOrNull(record, name) {
    return record[name] === null ? null : stringField(record, name);
}
function parseUseRow(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const session = stringField(value, 'session');
    const useClass = stringField(value, 'useClass');
    const model = textOrNull(value, 'model');
    const effort = textOrNull(value, 'effort');
    const w = numberField(value, 'w');
    const input = numberField(value, 'input');
    const cacheWrite = numberField(value, 'cacheWrite');
    const cacheRead = numberField(value, 'cacheRead');
    const output = numberField(value, 'output');
    const turns = numberField(value, 'turns');
    const calls = numberField(value, 'calls');
    const seconds = numberField(value, 'seconds');
    if (session === undefined ||
        !isUseClass(useClass) ||
        model === undefined ||
        effort === undefined ||
        w === undefined ||
        input === undefined ||
        cacheWrite === undefined ||
        cacheRead === undefined ||
        output === undefined ||
        turns === undefined ||
        calls === undefined ||
        seconds === undefined) {
        return undefined;
    }
    return { session, useClass, model, effort, w, input, cacheWrite, cacheRead, output, turns, calls, seconds };
}
function parseTaskRow(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const session = stringField(value, 'session');
    const task = textOrNull(value, 'task');
    const w = numberField(value, 'w');
    const seconds = numberField(value, 'seconds');
    return session === undefined || task === undefined || w === undefined || seconds === undefined ? undefined : { session, task, w, seconds };
}
/** Every entry of a stored list; undefined when it is no list or any entry is damaged, as half a day would read as a low one. */
function parseAll(value, parse) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const parsed = value.flatMap((entry) => {
        const row = parse(entry);
        return row === undefined ? [] : [row];
    });
    return parsed.length === value.length ? parsed : undefined;
}
/** The rollup file's text; undefined when it is damaged or in a format this teamrig cannot read. */
export function parseRollup(text) {
    const parsed = parseObject(text);
    if (parsed === undefined || recordVersion(parsed) !== ROLLUP_FORMAT) {
        return undefined;
    }
    const day = stringField(parsed, 'day');
    const team = stringField(parsed, 'team');
    const rows = parseAll(parsed['rows'], parseUseRow);
    const tasks = parseAll(parsed['tasks'], parseTaskRow);
    if (day === undefined || !ROLLUP_DAY.test(day) || team === undefined || rows === undefined || tasks === undefined) {
        return undefined;
    }
    return { day, team, rows, tasks };
}
