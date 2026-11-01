import { join } from 'node:path';
import { recordField, stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { entryOfRecord, entryRecord } from "./entry.js";
import { sessionFileIn, sessionOfFile } from "./registry.js";
/** How long an entry the restore dropped stays in the archive, so the session can still be found and reopened. */
export const ARCHIVE_KEEP_MS = 7 * 24 * 60 * 60_000;
/** The restore's archive, beside its sessions folder: the entries it dropped, kept ARCHIVE_KEEP_MS (T1747). */
export function restoreArchiveDir(kitHome) {
    return join(kitHome, 'restore', 'archive');
}
function formatArchived({ entry, archivedAt, reason }) {
    return `${JSON.stringify({ archivedAt: new Date(archivedAt).toISOString(), reason, entry: entryRecord(entry) }, null, 2)}\n`;
}
/** An archive file's text; undefined when it is damaged or of another shape. */
export function parseArchived(text) {
    const record = parseObject(text.trim());
    if (record === undefined) {
        return undefined;
    }
    const nested = recordField(record, 'entry');
    const entry = nested === undefined ? undefined : entryOfRecord(nested);
    const archivedAt = Date.parse(stringField(record, 'archivedAt') ?? '');
    const reason = stringField(record, 'reason');
    return entry === undefined || reason === undefined || Number.isNaN(archivedAt) ? undefined : { entry, archivedAt, reason };
}
/**
 * The entries the restore dropped, one file per Claude Code session (`<session id>.json`), each replaced whole. A
 * dropped entry is moved here rather than deleted, so a session the restore judged wrongly is never lost (11-01: a
 * logon check deleted 15 tabs the owner had closed by hand); an entry older than ARCHIVE_KEEP_MS is purged.
 */
export class RestoreArchive {
    files;
    dir;
    constructor(files, dir) {
        this.files = files;
        this.dir = dir;
    }
    /** Keeps the entry; a session archived again replaces its older copy. */
    async put(archived) {
        await this.files.write(sessionFileIn(this.dir, archived.entry.claudeSession), formatArchived(archived));
    }
    /** A session's archived entry; undefined when there is none or it is damaged. */
    async read(claudeSession) {
        const text = await this.files.read(sessionFileIn(this.dir, claudeSession));
        const archived = text === undefined ? undefined : parseArchived(text);
        return archived?.entry.claudeSession === claudeSession ? archived : undefined;
    }
    /** Every readable archived entry, the earliest archived first; a damaged file or one of another name is skipped. */
    async list() {
        const archived = [];
        for (const name of await this.files.list(this.dir)) {
            const id = sessionOfFile(name);
            const one = id === undefined ? undefined : await this.read(id);
            if (one !== undefined) {
                archived.push(one);
            }
        }
        return archived.sort((a, b) => a.archivedAt - b.archivedAt);
    }
    /** Deletes the entries archived ARCHIVE_KEEP_MS or longer before now; the ones it deleted. */
    async purge(now) {
        const expired = (await this.list()).filter(({ archivedAt }) => now - archivedAt >= ARCHIVE_KEEP_MS);
        for (const { entry } of expired) {
            await this.files.remove(sessionFileIn(this.dir, entry.claudeSession));
        }
        return expired;
    }
}
