import { join } from 'node:path';
import { stringField } from "./guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "./jsonl.js";
/**
 * A one-time ask a command records for a session and that session's Stop hook turns into one block: `set` writes
 * it when a task change calls for it, the hook removes it before it asks. The ask for a hired session's handover
 * (hiring/last-task-ask.ts) and the keep-working ask (wake/keep-working.ts) each keep their own folder of them.
 */
export const SESSION_ASK_FORMAT = 1;
/** An ask file's content; undefined when it is damaged or from another format. */
export function parseSessionAsk(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== SESSION_ASK_FORMAT) {
        return undefined;
    }
    const task = stringField(record, 'task');
    const at = stringField(record, 'at');
    return task === undefined || at === undefined ? undefined : { task, at };
}
export function formatSessionAsk(ask) {
    return toJsonlLine({ [VERSION_FIELD]: SESSION_ASK_FORMAT, task: ask.task, at: ask.at });
}
/** The due asks of one kind, one small file per session (`<id>.json`). Ids are session ids, checked by the roster, so they are safe in a path. */
export class SessionAskStore {
    files;
    folder;
    constructor(files, folder) {
        this.files = files;
        this.folder = folder;
    }
    /** The session's due ask; none when there is none or its file is damaged. */
    async get(id) {
        const text = await this.files.read(this.pathOf(id));
        return text === undefined ? undefined : parseSessionAsk(text);
    }
    async set(id, ask) {
        await this.files.write(this.pathOf(id), formatSessionAsk(ask));
    }
    async clear(id) {
        await this.files.remove(this.pathOf(id));
    }
    pathOf(id) {
        return join(this.folder, `${id}.json`);
    }
}
