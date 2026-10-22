import { isRecord, isStringArray } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { MS_PER_DAY, MS_PER_HOUR } from "../core/time.js";
/**
 * The format of the file this code reads and writes; a file in another format reads as none told. The `seen` times
 * came later as an optional field, so a teamrig that reads only `told` still reads the file.
 */
export const UNOWNED_NOTICES_FORMAT = 1;
/**
 * How long a told warning no start sees stays told. Whether a warning stands depends on what the start reads (the
 * project folder of its cwd and that folder's newest transcript), so one start not seeing it says little: only a
 * day without any start seeing it lets the lead be told again.
 */
export const UNOWNED_FORGET_AFTER_MS = MS_PER_DAY;
/** How stale a standing warning's seen time may grow before a start writes it again, so most starts write nothing. */
export const UNOWNED_SEEN_REFRESH_MS = MS_PER_HOUR;
/** The warnings the lead was told of; undefined when the text is damaged or from another format. */
export function parseUnownedNotices(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== UNOWNED_NOTICES_FORMAT) {
        return undefined;
    }
    const told = record['told'];
    if (!isStringArray(told)) {
        return undefined;
    }
    const seen = record['seen'];
    const seenAt = isRecord(seen) ? seen : {};
    return new Map(told.map((key) => [key, timeOf(seenAt[key])]));
}
function timeOf(value) {
    const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isNaN(at) ? undefined : at;
}
export function formatUnownedNotices(told) {
    const seen = Object.fromEntries([...told].map(([key, at]) => [key, new Date(at).toISOString()]));
    return toJsonlLine({ [VERSION_FIELD]: UNOWNED_NOTICES_FORMAT, told: [...told.keys()], seen });
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
/**
 * What stays told after a start at `now`: the told keys, those standing or just posted seen `now`, and the rest while
 * they were seen less than UNOWNED_FORGET_AFTER_MS ago. A key with no seen time starts its clock `now`. A warning no
 * start saw for that long drops out, so it is told again if it returns.
 */
export function toldAfter(told, standing, posted, now) {
    const keys = new Set(standing.map((warning) => warning.key));
    const next = new Map();
    for (const [key, seenAt] of told) {
        if (keys.has(key) || seenAt === undefined) {
            next.set(key, now);
        }
        else if (now - seenAt < UNOWNED_FORGET_AFTER_MS) {
            next.set(key, seenAt);
        }
    }
    posted.forEach((warning) => next.set(warning.key, now));
    return next;
}
const NONE_TOLD = { posted: [], failed: [] };
/**
 * Which warnings no session owns the lead was told of, and when a start last saw each, one small file per team (T951).
 * Every session's `start` tells the lead of the new ones, so the file is read and written under a lock: starts after a
 * reboot run side by side, and each warning is told once while some start sees it at least once a day.
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
    /** The warnings told so far; none for an absent or damaged file. */
    async told() {
        const text = await this.files.read(this.path);
        return (text === undefined ? undefined : parseUnownedNotices(text)) ?? new Map();
    }
    /**
     * Tells the lead of at most `max` standing warnings not told yet, through `post`, and forgets those no start saw for
     * UNOWNED_FORGET_AFTER_MS. The lock is taken only when something changes, so most starts read one small file.
     */
    async tell(standing, max, post, now) {
        if (this.settled(await this.told(), standing, now)) {
            return NONE_TOLD;
        }
        return this.mutex.run(async () => {
            const told = await this.told();
            const posted = [];
            const failed = [];
            for (const warning of freshUnowned(standing, told.keys(), max)) {
                const problem = await post(warning);
                if (problem === undefined) {
                    posted.push(warning);
                }
                else {
                    failed.push({ warning, problem });
                }
            }
            const next = toldAfter(told, standing, posted, now);
            if (next.size !== told.size || [...next].some(([key, at]) => told.get(key) !== at)) {
                await this.files.write(this.path, formatUnownedNotices(next));
            }
            return { posted, failed };
        });
    }
    /**
     * True when every standing warning was told and nothing is due a write: each standing one seen within
     * UNOWNED_SEEN_REFRESH_MS, each other one within UNOWNED_FORGET_AFTER_MS, and none without a seen time.
     */
    settled(told, standing, now) {
        const keys = new Set(standing.map((warning) => warning.key));
        return (freshUnowned(standing, told.keys(), 1).length === 0 &&
            [...told].every(([key, seenAt]) => seenAt !== undefined && now - seenAt < (keys.has(key) ? UNOWNED_SEEN_REFRESH_MS : UNOWNED_FORGET_AFTER_MS)));
    }
}
