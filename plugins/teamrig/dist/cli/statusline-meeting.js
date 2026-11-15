import { MeetingStore, phaseOf } from "../meeting/state.js";
import { statusLineMeetingOf } from "../meeting/status-line.js";
import { teamSessionOf } from "./commands/hook-input.js";
import { rosterOf } from "./kit.js";
import { teamsAboveOf } from "./root-team.js";
/**
 * The meeting mark of the status line of `claudeSession`, a tab of team `own` (T2513), as the own team's
 * `meeting.statusLine` shows it: undefined with the marks off or no meeting open on its team or a team above, each of
 * which covers its cards (T2985). Only a tab of the own team can be the meeting tab, so the tab's session is looked
 * up there alone, and only while that team's meeting is open, keeping each tick to the meeting files' reads. A team
 * above whose config does not load adds no mark.
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
    const tab = phaseOf(ownMeeting, now).kind === 'open' ? await teamSessionOf(runtime, own.kit, await rosterOf(runtime, own.kit, own.config), claudeSession) : undefined;
    return statusLineMeetingOf({ shown, own: ownMeeting, above, now, tab });
}
