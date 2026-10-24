import { join } from 'node:path';
import { isNonNegativeInteger, stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
/** The format of the session record files this code reads and writes; a file in another format reads as absent. */
export const SESSION_RECORD_FORMAT = 1;
/** A record file's content; undefined when it is damaged or from another format. */
export function parseSessionRecord(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== SESSION_RECORD_FORMAT) {
        return undefined;
    }
    const claudePid = record['claudePid'];
    const claudeSession = stringField(record, 'claudeSession');
    const at = stringField(record, 'at');
    if (!isNonNegativeInteger(claudePid) || claudePid === 0 || claudeSession === undefined || at === undefined || Number.isNaN(Date.parse(at))) {
        return undefined;
    }
    if (!('transcript' in record)) {
        return { claudePid, claudeSession, at };
    }
    const transcript = stringField(record, 'transcript');
    return transcript === undefined || transcript === '' ? undefined : { claudePid, claudeSession, at, transcript };
}
export function formatSessionRecord(record) {
    return toJsonlLine({ [VERSION_FIELD]: SESSION_RECORD_FORMAT, ...record });
}
/** Each session's record. Ids are session ids, checked by the roster, so they are safe in a path. */
export class SessionRecordStore {
    files;
    folder;
    constructor(files, paths) {
        this.files = files;
        this.folder = paths.sessions;
    }
    /** The session's record; undefined when it has none, or the file is damaged or from another format. */
    async read(id) {
        const text = await this.files.read(this.pathOf(id));
        return text === undefined ? undefined : parseSessionRecord(text);
    }
    /** The records of `ids`, in their order: undefined for a session with none. */
    async readEach(ids) {
        return new Map(await Promise.all(ids.map(async (id) => [id, await this.read(id)])));
    }
    write(id, record) {
        return this.files.write(this.pathOf(id), formatSessionRecord(record));
    }
    pathOf(id) {
        return join(this.folder, `${id}.json`);
    }
}
