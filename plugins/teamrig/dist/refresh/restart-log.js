import { join } from 'node:path';
import { recordField, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
/**
 * Every automatic restart's outcome, one JSON line each in the team's `refresh/restarts.jsonl`. The restart
 * runs hidden and only a failure reaches the session's inbox, so this is what a trial or a live week of
 * refreshes is judged on (stuck, duplicate or lost sessions). About 9 lines a day for 12 sessions.
 */
export class RestartLog {
    files;
    path;
    constructor(files, paths) {
        this.files = files;
        this.path = join(paths.refresh, 'restarts.jsonl');
    }
    record(entry) {
        return this.files.append(this.path, `${JSON.stringify(entry)}\n`);
    }
    /** The newest row of `session`, as `check` names it (#705); undefined with none, damaged rows skipped. */
    async lastRowOf(session) {
        const lines = ((await this.files.read(this.path)) ?? '').split('\n');
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const row = rowOf(lines[index] ?? '');
            if (row !== undefined && row.session === session) {
                return row;
            }
        }
        return undefined;
    }
}
function rowOf(line) {
    const record = parseObject(line.trim());
    const result = record === undefined ? undefined : recordField(record, 'result');
    const session = record === undefined ? undefined : stringField(record, 'session');
    const endedAt = record === undefined ? undefined : stringField(record, 'endedAt');
    const kind = result === undefined ? undefined : stringField(result, 'kind');
    if (result === undefined || session === undefined || endedAt === undefined || kind === undefined) {
        return undefined;
    }
    return { session, endedAt, kind, why: stringField(result, 'why') ?? null };
}
