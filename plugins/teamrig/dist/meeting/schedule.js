import { isStringArray, numberField, stringField } from "../core/guards.js";
import { assertWritable, parseJsonl, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { MS_PER_DAY, MS_PER_MINUTE } from "../core/time.js";
import { MEETING_LAPSE_MS } from "./state.js";
/**
 * Scheduled meetings (`meeting schedule|list|move|start|end|drop`, T1358): a meeting the owner holds with one session at
 * a set time, apart from the daily meeting with the lead (state.ts). The team keeps them in `<state>/meetings.jsonl`,
 * one line per meeting (the newest of an id wins, should two be there), rewritten at each change under the team's
 * meetings lock. A finished meeting stays FINISHED_KEEP_DAYS, then a write drops it, as compaction drops the
 * register's done tasks.
 */
/** The format of a meeting line this code reads and writes; a line in another format is skipped, a newer one refuses a write. */
export const MEETING_SCHEDULE_FORMAT = 1;
/** How long a done or dropped meeting stays in the file, so `meeting list --all` shows the last week's. */
export const FINISHED_KEEP_DAYS = 8;
/** A meeting's length when its schedule names none. */
export const DEFAULT_MEETING_MINUTES = 30;
/** The longest `about` line, so a meeting lists on one line. */
export const ABOUT_MAX = 200;
export const MEETING_STATUSES = ['scheduled', 'started', 'done', 'dropped'];
function isMeetingStatus(value) {
    return MEETING_STATUSES.some((status) => status === value);
}
const MEETING_ID = /^M([1-9]\d{0,8})$/;
/** A meeting's id, `M<n>`, numbered per team; never a T id, which a field holds only for a real task. */
export function isMeetingId(text) {
    return MEETING_ID.test(text);
}
function idNumber(id) {
    const match = MEETING_ID.exec(id);
    return match === null ? 0 : Number(match[1]);
}
function instantOf(record, key) {
    const text = stringField(record, key);
    const at = text === undefined ? Number.NaN : Date.parse(text);
    return Number.isNaN(at) ? undefined : at;
}
/** A nullable field: undefined when it is missing or of another type, else its value or null. */
function nullableText(record, key) {
    const value = record[key];
    return value === null ? null : stringField(record, key);
}
function nullableInstant(record, key) {
    return record[key] === null ? null : instantOf(record, key);
}
export function parseScheduledMeeting(record) {
    const id = stringField(record, 'id');
    const at = instantOf(record, 'at');
    const minutes = numberField(record, 'minutes');
    const session = stringField(record, 'session');
    const joining = record['with'];
    const tasks = record['tasks'];
    const about = stringField(record, 'about');
    const brief = nullableText(record, 'brief');
    const status = record['status'];
    const notifiedAt = nullableInstant(record, 'notifiedAt');
    const by = stringField(record, 'by');
    const changedAt = instantOf(record, 'changedAt');
    const note = nullableText(record, 'note');
    if (id === undefined || !isMeetingId(id) || at === undefined || minutes === undefined || !Number.isInteger(minutes) || minutes <= 0) {
        return undefined;
    }
    if (session === undefined || !isStringArray(joining) || !isStringArray(tasks) || about === undefined || brief === undefined) {
        return undefined;
    }
    if (!isMeetingStatus(status) || notifiedAt === undefined || by === undefined || changedAt === undefined || note === undefined) {
        return undefined;
    }
    return { id, at, minutes, session, with: joining, tasks, about, brief, status, notifiedAt, by, changedAt, note };
}
function iso(at) {
    return new Date(at).toISOString();
}
function recordOf(meeting) {
    return {
        [VERSION_FIELD]: MEETING_SCHEDULE_FORMAT,
        id: meeting.id,
        at: iso(meeting.at),
        minutes: meeting.minutes,
        session: meeting.session,
        with: meeting.with,
        tasks: meeting.tasks,
        about: meeting.about,
        brief: meeting.brief,
        status: meeting.status,
        notifiedAt: meeting.notifiedAt === null ? null : iso(meeting.notifiedAt),
        by: meeting.by,
        changedAt: iso(meeting.changedAt),
        note: meeting.note,
    };
}
export function readMeetings(text) {
    const parse = parseJsonl(text);
    const newest = new Map();
    let skipped = parse.unreadable;
    let lastNumber = 0;
    for (const { record, version } of parse.records) {
        const meeting = version === MEETING_SCHEDULE_FORMAT ? parseScheduledMeeting(record) : undefined;
        if (meeting === undefined) {
            skipped += 1;
            continue;
        }
        newest.set(meeting.id, meeting);
        lastNumber = Math.max(lastNumber, idNumber(meeting.id));
    }
    return { meetings: [...newest.values()], skipped, lastNumber };
}
/** The id the next scheduled meeting takes. */
export function nextMeetingId(read) {
    return `M${read.lastNumber + 1}`;
}
/** A meeting still to be held: scheduled or started. */
export function isOpenMeeting(meeting) {
    return meeting.status === 'scheduled' || meeting.status === 'started';
}
/**
 * Whether `session` is in a booked meeting now, which holds its context refresh as the daily meeting holds the lead's
 * (src/refresh/decide.ts `meetingHolds`, T2111): one started (`meeting start M<n>`) that it is met in or joins, neither
 * ended nor dropped, and under MEETING_LAPSE_MS since its start, so a forgotten `meeting end` holds nothing for good.
 * The hold follows the start, not the slot, since a meeting the owner runs past its minutes is still on. A started
 * meeting's `changedAt` is its start: a move takes only a scheduled one, and an end or a drop finishes it.
 */
export function inBookedMeeting(meetings, session, now) {
    return meetings.some((meeting) => meeting.status === 'started' && (meeting.session === session || meeting.with.includes(session)) && now < meeting.changedAt + MEETING_LAPSE_MS);
}
/** When a meeting's slot ends, epoch ms. */
export function endOf(meeting) {
    return meeting.at + meeting.minutes * MS_PER_MINUTE;
}
/** A scheduled meeting whose slot is over with no start: shown as missed until it is moved, ended or dropped. */
export function isMissed(meeting, now) {
    return meeting.status === 'scheduled' && endOf(meeting) <= now;
}
/** A scheduled meeting whose time came and whose slot is not over, not yet notified: its notification is due. */
export function isNotifyDue(meeting, now) {
    return meeting.status === 'scheduled' && meeting.notifiedAt === null && meeting.at <= now && now < endOf(meeting);
}
/** When the next notification falls due after `now`, epoch ms; null when none is scheduled. */
export function nextNotifyAt(meetings, now) {
    const times = meetings.filter((meeting) => meeting.status === 'scheduled' && meeting.notifiedAt === null && meeting.at > now).map((meeting) => meeting.at);
    return times.length === 0 ? null : Math.min(...times);
}
/** The meetings by time, earliest first; ids break a tie. */
export function byTime(meetings) {
    return [...meetings].sort((a, b) => a.at - b.at || idNumber(a.id) - idNumber(b.id));
}
/** The records a write keeps: every open meeting, the finished ones of the last FINISHED_KEEP_DAYS, and the highest id. */
export function keptMeetings(read, now) {
    const since = now - FINISHED_KEEP_DAYS * MS_PER_DAY;
    return read.meetings.filter((meeting) => isOpenMeeting(meeting) || meeting.changedAt >= since || idNumber(meeting.id) === read.lastNumber);
}
/** The team's scheduled meetings, `<state>/meetings.jsonl`. Callers hold the meetings lock around a read and its write. */
export class MeetingSchedule {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        return readMeetings((await this.files.read(this.path)) ?? '');
    }
    /**
     * Records a change: the file is rewritten at once with the newest record of each meeting it keeps (keptMeetings) and
     * this one, so it stays one line per meeting; a damaged line goes with that write. Refused beside records from a
     * newer teamrig.
     */
    async write(meeting, now) {
        const text = (await this.files.read(this.path)) ?? '';
        assertWritable(this.path, parseJsonl(text), MEETING_SCHEDULE_FORMAT);
        const rest = keptMeetings(readMeetings(text), now).filter((other) => other.id !== meeting.id);
        await this.files.write(this.path, [...rest, meeting].map((record) => toJsonlLine(recordOf(record))).join(''));
    }
}
