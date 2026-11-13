import { stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { MS_PER_MINUTE } from "../core/time.js";
/**
 * The scheduled meeting the spotlight frames (T2662): `meeting start M<n>` dims every screen but the window of the
 * session met, as the daily meeting does for the lead's (spotlight.ts). The spotlight script watches a small JSON file
 * of `startedAt` and `endedAt`, the shape of the daily meeting file; the meetings file itself is JSONL whose newest line
 * of an id wins, too much for that script to read. So a start writes this file, and `meeting end` or `meeting drop` of
 * the same meeting sets its end. One file: a later start replaces it, which lifts the earlier spotlight, as a new daily
 * meeting lifts the last.
 */
/**
 * How long past its booked minutes a scheduled meeting stays spotlit when nobody ends it: a meeting the owner runs a
 * little long keeps the dimming, a forgotten `meeting end` does not hold it for the daily meeting's 4 h.
 */
export const SPOTLIT_GRACE_MS = 15 * MS_PER_MINUTE;
/** When the spotlight of `meeting`, started at `startedAt` (epoch ms), lifts with no end: its minutes and the grace. */
export function spotlitUntil(meeting, startedAt) {
    return startedAt + meeting.minutes * MS_PER_MINUTE + SPOTLIT_GRACE_MS;
}
/** The file's content; undefined when it is damaged. */
export function parseSpotlit(text) {
    const record = parseObject(text.trim());
    if (record === undefined) {
        return undefined;
    }
    const id = stringField(record, 'id');
    const startedAt = stringField(record, 'startedAt');
    const endedAt = record['endedAt'];
    if (id === undefined || startedAt === undefined || (endedAt !== null && typeof endedAt !== 'string')) {
        return undefined;
    }
    return { id, startedAt, endedAt };
}
export class SpotlitStore {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        const text = await this.files.read(this.path);
        return text === undefined ? undefined : parseSpotlit(text);
    }
    /** Records meeting `id` as started at `startedAt` (ISO) and on. */
    async start(id, startedAt) {
        await this.write({ id, startedAt, endedAt: null });
    }
    /** Records meeting `id` as ended at `endedAt` (ISO), when the file holds it still on; another meeting's spotlight stays. */
    async end(id, endedAt) {
        const spotlit = await this.read();
        if (spotlit === undefined || spotlit.id !== id || spotlit.endedAt !== null) {
            return false;
        }
        await this.write({ ...spotlit, endedAt });
        return true;
    }
    async write(spotlit) {
        await this.files.write(this.path, `${JSON.stringify({ id: spotlit.id, startedAt: spotlit.startedAt, endedAt: spotlit.endedAt })}\n`);
    }
}
