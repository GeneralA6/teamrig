import { isStringArray } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
/** The format of the file this code reads and writes; a file in another format reads as none told. */
export const UNOWNED_NOTICES_FORMAT = 1;
/** The keys of the warnings the lead was told of; undefined when the text is damaged or from another format. */
export function parseUnownedNotices(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== UNOWNED_NOTICES_FORMAT) {
        return undefined;
    }
    const told = record['told'];
    return isStringArray(told) ? told : undefined;
}
export function formatUnownedNotices(told) {
    return toJsonlLine({ [VERSION_FIELD]: UNOWNED_NOTICES_FORMAT, told: [...told] });
}
/**
 * The warnings the lead is still to be told of, in order: one per key (two flags of one kind on one skill share it), none
 * already told, at most `max`.
 */
export function freshUnowned(standing, told, max) {
    const seen = new Set(told);
    const fresh = [];
    for (const warning of standing) {
        if (fresh.length < max && !seen.has(warning.key)) {
            seen.add(warning.key);
            fresh.push(warning);
        }
    }
    return fresh;
}
/** What stays told after a start: the told keys still standing, then those just posted. A cleared one drops out, so it is told again if it returns. */
export function toldAfter(told, standing, posted) {
    const keys = new Set(standing.map((warning) => warning.key));
    return [...new Set([...[...told].filter((key) => keys.has(key)), ...posted.map((warning) => warning.key)])];
}
const NONE_TOLD = { posted: [], failed: [] };
/**
 * Which warnings no session owns the lead was told of, one small file per team (T951). Every session's `start` tells
 * the lead of the new ones, so the file is read and written under a lock: starts after a reboot run side by side, and
 * each warning is told once while it stands.
 */
export class UnownedNotices {
    files;
    path;
    mutex;
    constructor(files, path, mutex) {
        this.files = files;
        this.path = path;
        this.mutex = mutex;
    }
    /** The keys told so far; none for an absent or damaged file. */
    async told() {
        const text = await this.files.read(this.path);
        return new Set(text === undefined ? [] : (parseUnownedNotices(text) ?? []));
    }
    /**
     * Tells the lead of at most `max` standing warnings not told yet, through `post`, and forgets the cleared ones. The
     * lock is taken only when something changes, so a start with nothing new reads one small file.
     */
    async tell(standing, max, post) {
        if (this.settled(await this.told(), standing)) {
            return NONE_TOLD;
        }
        return this.mutex.run(async () => {
            const told = await this.told();
            const posted = [];
            const failed = [];
            for (const warning of freshUnowned(standing, told, max)) {
                const problem = await post(warning);
                if (problem === undefined) {
                    posted.push(warning);
                }
                else {
                    failed.push({ warning, problem });
                }
            }
            const next = toldAfter(told, standing, posted);
            if (next.length !== told.size || next.some((key) => !told.has(key))) {
                await this.files.write(this.path, formatUnownedNotices(next));
            }
            return { posted, failed };
        });
    }
    /** True when every standing warning was told and every told one still stands. */
    settled(told, standing) {
        const keys = new Set(standing.map((warning) => warning.key));
        return freshUnowned(standing, told, 1).length === 0 && [...told].every((key) => keys.has(key));
    }
}
