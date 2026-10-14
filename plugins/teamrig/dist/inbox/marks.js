import { createHash } from 'node:crypto';
import { isNonNegativeInteger, stringField } from "../core/guards.js";
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
/** A short, stable fingerprint of one inbox line. */
export function lineHash(text) {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
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
