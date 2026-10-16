import { isNonNegativeInteger, stringField } from "../core/guards.js";
import { parseJsonl } from "../core/jsonl.js";
import { SESSION_NAME } from "../register/model.js";
export const MARK_VERSION = 1;
/** A Claude Code session id, as hook stdin and `$CLAUDE_CODE_SESSION_ID` carry it. */
export const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseMark(line) {
    if (line.version > MARK_VERSION) {
        return { kind: 'newer' };
    }
    const { record } = line;
    const area = stringField(record, 'area');
    const count = record['line'];
    const at = stringField(record, 'at');
    const claudeSession = record['claudeSession'] ?? null;
    const lastLineHash = record['lastLineHash'] ?? null;
    const valid = area !== undefined &&
        SESSION_NAME.test(area) &&
        isNonNegativeInteger(count) &&
        at !== undefined &&
        !Number.isNaN(Date.parse(at)) &&
        (claudeSession === null || (typeof claudeSession === 'string' && CLAUDE_SESSION_ID.test(claudeSession))) &&
        (lastLineHash === null || typeof lastLineHash === 'string');
    return valid ? { kind: 'mark', mark: { v: line.version, area, line: count, at, claudeSession, lastLineHash } } : { kind: 'unreadable' };
}
/** The marks an `inbox-marks.jsonl` text holds, in write order; damaged and newer lines are counted, never fatal. */
export function readMarks(text) {
    const parse = parseJsonl(text);
    const marks = [];
    let unreadable = parse.unreadable;
    let newer = 0;
    for (const line of parse.records) {
        const result = parseMark(line);
        if (result.kind === 'mark') {
            marks.push(result.mark);
        }
        else if (result.kind === 'newer') {
            newer += 1;
        }
        else {
            unreadable += 1;
        }
    }
    return { marks, unreadable, newer };
}
/**
 * The Claude Code session that last read `area`'s inbox and is still bound to it (its own newest mark names
 * `area`); undefined when none is on record.
 */
export function lastClaudeSessionOf(marks, area) {
    const bound = indexMarks(marks).areaBySession;
    const mark = [...marks].reverse().find((found) => found.area === area && found.claudeSession !== null && bound.get(found.claudeSession) === area);
    return mark?.claudeSession ?? undefined;
}
/** The newest mark wins, both for an area's read position and for a session's area. */
export function indexMarks(marks) {
    const byArea = new Map();
    const areaBySession = new Map();
    for (const mark of marks) {
        byArea.set(mark.area, mark);
        if (mark.claudeSession !== null) {
            areaBySession.set(mark.claudeSession, mark.area);
        }
    }
    return { byArea, areaBySession };
}
