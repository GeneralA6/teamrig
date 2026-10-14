import { isNonNegativeInteger, isRecord } from "./guards.js";
/** The field every record written by this kit carries; a record without it is version 0. */
export const VERSION_FIELD = 'v';
/** Parses an append-only JSONL log. Blank lines are ignored; a damaged line is counted, never thrown. */
export function parseJsonl(text) {
    const records = [];
    let unreadable = 0;
    text.split('\n').forEach((line, index) => {
        const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (raw.trim() === '') {
            return;
        }
        const record = parseObject(raw);
        const version = record === undefined ? undefined : recordVersion(record);
        if (record === undefined || version === undefined) {
            unreadable += 1;
            return;
        }
        records.push({ lineNumber: index + 1, raw, record, version });
    });
    return { records, unreadable };
}
/** The record's format version: 0 when the field is absent, undefined when it is present but invalid. */
export function recordVersion(record) {
    const version = record[VERSION_FIELD];
    if (version === undefined) {
        return 0;
    }
    return isNonNegativeInteger(version) ? version : undefined;
}
/** One whole JSONL line. JSON.stringify escapes newlines inside strings, so the line never splits. */
export function toJsonlLine(record) {
    return `${JSON.stringify(record)}\n`;
}
function parseObject(raw) {
    try {
        const value = JSON.parse(raw);
        return isRecord(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/** Thrown before a write when the log already holds records newer than this code understands. */
export class NewerDataError extends Error {
    file;
    found;
    known;
    constructor(file, found, known) {
        super(`${file} holds format v${found} records; this version writes v${known}. Update teamrig before writing.`);
        this.name = 'NewerDataError';
        this.file = file;
        this.found = found;
        this.known = known;
    }
}
/** Refuses a write beside records this code cannot interpret, so an old binary never mixes formats. */
export function assertWritable(file, parse, knownVersion) {
    const newest = parse.records.reduce((max, record) => Math.max(max, record.version), 0);
    if (newest > knownVersion) {
        throw new NewerDataError(file, newest, knownVersion);
    }
}
