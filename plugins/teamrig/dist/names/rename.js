import { stringField } from "../core/guards.js";
import { ID_PATTERN, NAME_PATTERN } from "../core/ids.js";
import { parseJsonl, parseObject } from "../core/jsonl.js";
export const RENAME_VERSION = 1;
export function parseRename(line) {
    if (line.version > RENAME_VERSION) {
        return { kind: 'newer' };
    }
    const { record } = line;
    const id = stringField(record, 'id');
    const from = stringField(record, 'from');
    const to = stringField(record, 'to');
    const at = stringField(record, 'at');
    const by = stringField(record, 'by');
    if (id === undefined ||
        !ID_PATTERN.test(id) ||
        from === undefined ||
        !NAME_PATTERN.test(from) ||
        to === undefined ||
        !NAME_PATTERN.test(to) ||
        from === to ||
        at === undefined ||
        Number.isNaN(Date.parse(at)) ||
        by === undefined ||
        !ID_PATTERN.test(by)) {
        return { kind: 'unreadable' };
    }
    return { kind: 'rename', rename: { v: line.version, id, from, to, at, by } };
}
/** The renames in the text of a rename log (`renames.jsonl`), counting the lines it skips. */
export function readRenames(text) {
    const parse = parseJsonl(text);
    const renames = [];
    let unreadable = parse.unreadable;
    let newer = 0;
    for (const line of parse.records) {
        const result = parseRename(line);
        if (result.kind === 'rename') {
            renames.push(result.rename);
        }
        else if (result.kind === 'newer') {
            newer += 1;
        }
        else {
            unreadable += 1;
        }
    }
    return { renames, unreadable, newer };
}
/**
 * The lines of a rename log's text that rename one of `ids`, for a team split that moves those sessions, and the
 * rest. A damaged line, or one without an id, stays with the rest, as the log it was in still reports it.
 */
export function splitRenameLog(text, ids) {
    const of = [];
    const rest = [];
    for (const line of text.split('\n').filter((each) => each.trim() !== '')) {
        const record = parseObject(line.endsWith('\r') ? line.slice(0, -1) : line);
        const id = record === undefined ? undefined : stringField(record, 'id');
        (id !== undefined && ids.has(id) ? of : rest).push(line);
    }
    const textOf = (lines) => lines.map((line) => `${line}\n`).join('');
    return { of: textOf(of), rest: textOf(rest), moved: of.length };
}
