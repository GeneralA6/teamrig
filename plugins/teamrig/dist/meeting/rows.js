import { byTime, isMissed, isOpenMeeting } from "./schedule.js";
/** The meetings by time, one row each: the one list both `meeting list --json` and `read meetings` print. */
export function meetingRows(input) {
    const shown = byTime(input.all ? input.meetings : input.meetings.filter(isOpenMeeting));
    return shown.map((meeting) => {
        const at = new Date(meeting.at);
        return {
            id: meeting.id,
            at: at.toISOString(),
            atText: input.atText(at),
            minutes: meeting.minutes,
            session: meeting.session,
            with: meeting.with,
            tasks: meeting.tasks,
            about: meeting.about,
            brief: meeting.brief,
            status: meeting.status,
            missed: isMissed(meeting, input.now),
        };
    });
}
