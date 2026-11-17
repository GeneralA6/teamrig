import { isStringArray, stringField } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD, writableObject } from "../core/jsonl.js";
import { MS_PER_HOUR } from "../core/time.js";
/**
 * The owner's daily meeting with the lead (`meeting start|agenda|end`): while one is open, the cold-send hook holds
 * every message to the lead but a CRITICAL one (quiet.ts), and the lead's context refresh waits for its end
 * (src/refresh/decide.ts). One small file holds the latest meeting, written only by the lead's own `meeting` commands.
 */
/**
 * The format of the meeting file this code writes: 2 added the meeting's `kind` (T3137). It reads format 1 too, as a
 * daily meeting; a file in any other format reads as no meeting.
 */
export const MEETING_FORMAT = 2;
/** The format before the meeting's kind, read as a daily meeting. */
const MEETING_FORMAT_NO_KIND = 1;
/** A meeting never ended stops holding messages this long after it started, so a forgotten `meeting end` never silences the lead for good. */
export const MEETING_LAPSE_MS = 4 * MS_PER_HOUR;
/**
 * Which meeting a bare `meeting start` opened (T3137): the day's first is the owner's `daily` meeting, and one started
 * after it on the same day, on the team's clock, is an `extra` one, so the status line does not call it daily.
 */
export const MEETING_KINDS = ['daily', 'extra'];
function isMeetingKind(value) {
    return MEETING_KINDS.some((kind) => kind === value);
}
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
/** Whether `session` is in a meeting now: the meeting is open and `session` started it (the lead). */
export function inMeeting(meeting, session, now) {
    return meeting?.by === session && phaseOf(meeting, now).kind === 'open';
}
/**
 * The kind of meeting a bare `meeting start` opens now, after the latest meeting's `phase` (T3137): an extra one when
 * the latest started earlier the same day on the team's clock, so only the day's first is the owner's daily meeting.
 */
export function startingKindOf(phase, now, zone) {
    return phase.kind !== 'none' && zone.day(new Date(phase.meeting.startedAt)) === zone.day(new Date(now)) ? 'extra' : 'daily';
}
/** When the meeting a phase names stopped: its end, or its lapse; undefined for an open meeting or none. */
export function stoppedAt(phase) {
    return phase.kind === 'closed' || phase.kind === 'lapsed' ? phase.until : undefined;
}
/** A meeting file's content; undefined when it is damaged or from another format. */
export function parseMeeting(text) {
    const record = parseObject(text.trim());
    const format = record?.[VERSION_FIELD];
    if (record === undefined || (format !== MEETING_FORMAT && format !== MEETING_FORMAT_NO_KIND)) {
        return undefined;
    }
    const startedAt = stringField(record, 'startedAt');
    const by = stringField(record, 'by');
    const endedAt = record['endedAt'];
    const since = record['since'];
    const carried = record['carried'] ?? [];
    const kind = format === MEETING_FORMAT_NO_KIND ? 'daily' : record['kind'];
    if (startedAt === undefined || by === undefined || Number.isNaN(Date.parse(startedAt))) {
        return undefined;
    }
    if ((endedAt !== null && typeof endedAt !== 'string') || (since !== null && typeof since !== 'string') || !isStringArray(carried) || !isMeetingKind(kind)) {
        return undefined;
    }
    return { startedAt, by, endedAt, since, carried, kind };
}
export function formatMeeting(meeting) {
    const { startedAt, by, endedAt, since, carried, kind } = meeting;
    return toJsonlLine({ [VERSION_FIELD]: MEETING_FORMAT, startedAt, by, endedAt, since, carried: [...carried], kind });
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
    /** Writes over the latest meeting; refuses (NewerDataError) a file a newer teamrig wrote, so none of its fields is lost. */
    async write(meeting) {
        writableObject(this.path, await this.files.read(this.path), MEETING_FORMAT);
        await this.files.write(this.path, formatMeeting(meeting));
    }
}
