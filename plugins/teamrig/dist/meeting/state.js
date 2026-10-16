import { stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { MS_PER_HOUR } from "../core/time.js";
/**
 * The owner's daily meeting with the lead (`meeting start|agenda|end`): while one is open, the cold-send hook holds
 * every message to the lead but a CRITICAL one (quiet.ts). One small file holds the latest meeting, written only by
 * the lead's own `meeting` commands.
 */
/** The format of the meeting file this code reads and writes; a file in another format reads as no meeting. */
export const MEETING_FORMAT = 1;
/** A meeting never ended stops holding messages this long after it started, so a forgotten `meeting end` never silences the lead for good. */
export const MEETING_LAPSE_MS = 4 * MS_PER_HOUR;
export function phaseOf(meeting, now) {
    if (meeting === undefined) {
        return { kind: 'none' };
    }
    if (meeting.endedAt !== null) {
        return { kind: 'closed', meeting, until: Date.parse(meeting.endedAt) };
    }
    const lapse = Date.parse(meeting.startedAt) + MEETING_LAPSE_MS;
    return now < lapse ? { kind: 'open', meeting } : { kind: 'lapsed', meeting, until: lapse };
}
/** When the meeting a phase names stopped: its end, or its lapse; undefined for an open meeting or none. */
export function stoppedAt(phase) {
    return phase.kind === 'closed' || phase.kind === 'lapsed' ? phase.until : undefined;
}
/** A meeting file's content; undefined when it is damaged or from another format. */
export function parseMeeting(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== MEETING_FORMAT) {
        return undefined;
    }
    const startedAt = stringField(record, 'startedAt');
    const by = stringField(record, 'by');
    const endedAt = record['endedAt'];
    const since = record['since'];
    if (startedAt === undefined || by === undefined || Number.isNaN(Date.parse(startedAt))) {
        return undefined;
    }
    if ((endedAt !== null && typeof endedAt !== 'string') || (since !== null && typeof since !== 'string')) {
        return undefined;
    }
    return { startedAt, by, endedAt, since };
}
export function formatMeeting(meeting) {
    return toJsonlLine({ [VERSION_FIELD]: MEETING_FORMAT, startedAt: meeting.startedAt, by: meeting.by, endedAt: meeting.endedAt, since: meeting.since });
}
/** The latest meeting, one small JSON file (`state/meeting.json`). */
export class MeetingStore {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    /** The latest meeting; undefined when none was held or the file is damaged, which holds no message. */
    async read() {
        const text = await this.files.read(this.path);
        return text === undefined ? undefined : parseMeeting(text);
    }
    async write(meeting) {
        await this.files.write(this.path, formatMeeting(meeting));
    }
}
