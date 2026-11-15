import { MeetingSchedule, meetingsOnOf } from "../meeting/schedule.js";
import { MeetingStore, phaseOf } from "../meeting/state.js";
import { statusLineMeetingOf } from "../meeting/status-line.js";
import { teamSessionOf } from "./commands/hook-input.js";
import { rosterOf } from "./kit.js";
import { teamsAboveOf } from "./root-team.js";
/**
 * The meeting mark of the status line of `claudeSession`, a tab of team `own` (T2513), as the own team's
 * `meeting.statusLine` shows it: undefined with the marks off or no meeting on its team or a team above, each daily
 * one of which covers its cards (T2985). Only a tab of the own team can be the meeting tab, a booked meeting's too, so
 * the tab's session is looked up there alone, and only while that team's daily meeting is open or a booked one is on,
 * keeping each tick to the meeting files' reads. A team above whose config does not load adds no mark.
 */
export async function statusLineMeetingFor(runtime, own, claudeSession) {
    const shown = own.config.meeting.statusLine;
    if (!shown.enabled) {
        return undefined;
    }
    const now = runtime.clock.now();
    const read = (team) => new MeetingStore(runtime.files, team.kit.paths.meeting).read();
    const ownMeeting = await read(own);
    const above = await Promise.all(((await teamsAboveOf(runtime, own)) ?? []).map(read));
    const booked = meetingsOnOf((await new MeetingSchedule(runtime.files, own.kit.paths.meetings).read()).meetings, now);
    const tab = phaseOf(ownMeeting, now).kind === 'open' || booked.length > 0 ? await teamSessionOf(runtime, own.kit, await rosterOf(runtime, own.kit, own.config), claudeSession) : undefined;
    return statusLineMeetingOf({ shown, own: ownMeeting, above, booked, now, tab });
}
