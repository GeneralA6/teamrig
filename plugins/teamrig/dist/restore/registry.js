import { join } from 'node:path';
import { CLAUDE_SESSION_ID } from "../inbox/marks.js";
import { formatEntry, parseEntry } from "./entry.js";
const SUFFIX = '.json';
/**
 * The restore's sessions folder, under the kit home and not a team's: it follows every Claude Code session on
 * the machine, in a team or not, since a reboot ends them all.
 */
export function restoreSessionsDir(kitHome) {
    return join(kitHome, 'restore', 'sessions');
}
/** The restore's log, beside its sessions folder: what each check, run and login change decided, for the morning after. */
export function restoreLogPath(kitHome) {
    return join(kitHome, 'restore', 'restore.log');
}
/**
 * The file named for a session in a folder of the restore (`<session id>.json`). Only a real session id names a
 * file; any other is refused, so no id from a payload reaches a path.
 */
export function sessionFileIn(dir, claudeSession) {
    if (!CLAUDE_SESSION_ID.test(claudeSession)) {
        throw new Error(`${JSON.stringify(claudeSession)} is not a Claude Code session id`);
    }
    return join(dir, `${claudeSession}${SUFFIX}`);
}
/** The session id a file of a restore folder is named for; undefined for a file of another name. */
export function sessionOfFile(name) {
    const id = name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : '';
    return CLAUDE_SESSION_ID.test(id) ? id : undefined;
}
/**
 * One entry file per Claude Code session (`<session id>.json`), each replaced whole (`Files.write` is
 * atomic), so a reader never sees half an entry. Only a real session id names a file; any other is
 * refused, so no id from a payload reaches a path.
 */
export class RestoreRegistry {
    files;
    dir;
    constructor(files, dir) {
        this.files = files;
        this.dir = dir;
    }
    /** The file a session's entry is kept in. */
    pathOf(claudeSession) {
        return sessionFileIn(this.dir, claudeSession);
    }
    /** A session's entry; undefined when there is none or it is damaged. */
    async read(claudeSession) {
        const text = await this.files.read(this.pathOf(claudeSession));
        return text === undefined ? undefined : parseEntry(text);
    }
    async write(entry) {
        await this.files.write(this.pathOf(entry.claudeSession), formatEntry(entry));
    }
    async remove(claudeSession) {
        await this.files.remove(this.pathOf(claudeSession));
    }
    /** Every readable entry, oldest first; a damaged file or one of another name is skipped. */
    async list() {
        const names = await this.files.list(this.dir);
        const entries = [];
        for (const name of names) {
            const id = sessionOfFile(name);
            const entry = id === undefined ? undefined : await this.read(id);
            if (entry !== undefined && entry.claudeSession === id) {
                entries.push(entry);
            }
        }
        return entries.sort((a, b) => a.createdAt - b.createdAt);
    }
}
