import { MS_PER_HOUR, MS_PER_MINUTE } from "../core/time.js";
import { endOf } from "./schedule.js";
/**
 * When a booked meeting tells the person of itself (T2405): `before` its slot, at its `start`, and `missed` once it is
 * past its slot's time with no `meeting start`. Each stage goes out once. The meeting's `notifiedAt` is when its last
 * notice went out, so a stage whose time is at or before it has gone out, and a move (which clears it) sends each
 * again. A tab that first looks late sends only the latest stage due, never the ones it slept through.
 */
export const NOTICE_STAGES = ['before', 'start', 'missed'];
/**
 * How long past its time a missed alert may still go out: a tab first opened later that day still raises it, while a
 * meeting left scheduled from an earlier day raises none.
 */
export const MISSED_ALERT_WINDOW_MS = 12 * MS_PER_HOUR;
/** The meeting's stages the config keeps on, earliest first; none when its notices are off. */
function windowsOf(meeting, config) {
    if (!config.enabled) {
        return [];
    }
    const windows = [];
    if (config.beforeMinutes > 0) {
        windows.push({ stage: 'before', from: meeting.at - config.beforeMinutes * MS_PER_MINUTE, until: meeting.at });
    }
    if (config.atStart) {
        windows.push({ stage: 'start', from: meeting.at, until: endOf(meeting) });
    }
    if (config.missedAfterMinutes > 0) {
        const from = meeting.at + config.missedAfterMinutes * MS_PER_MINUTE;
        windows.push({ stage: 'missed', from, until: from + MISSED_ALERT_WINDOW_MS });
    }
    return windows;
}
/** A stage still to go out: the meeting is scheduled and no notice went out at or after the stage's time. */
function isPending(meeting, window) {
    return meeting.status === 'scheduled' && (meeting.notifiedAt === null || meeting.notifiedAt < window.from);
}
/** The stage due now, the latest one whose window holds `now`; undefined when none is. */
export function dueStage(meeting, now, config) {
    const due = windowsOf(meeting, config).filter((window) => window.from <= now && now < window.until && isPending(meeting, window));
    return due.at(-1)?.stage;
}
/** When the next stage of any meeting falls due after `now`, epoch ms; null when none is ahead. */
export function nextStageAt(meetings, now, config) {
    const times = meetings.flatMap((meeting) => windowsOf(meeting, config).filter((window) => window.from > now && isPending(meeting, window)).map((window) => window.from));
    return times.length === 0 ? null : Math.min(...times);
}
