import { MeetingStore, phaseOf, type Meeting } from '../meeting/state.ts';
import { statusLineMeetingOf, type StatusLineMeeting } from '../meeting/status-line.ts';
import { teamSessionOf } from './commands/hook-input.ts';
import { rosterOf } from './kit.ts';
import { teamsAboveOf, type LoadedTeam } from './root-team.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The meeting mark of the status line of `claudeSession`, a tab of team `own` (T2513), as the own team's
 * `meeting.statusLine` shows it: undefined with the marks off or no meeting open on its team or a team above, each of
 * which covers its cards (T2985). Only a tab of the own team can be the meeting tab, so the tab's session is looked
 * up there alone, and only while that team's meeting is open, keeping each tick to the meeting files' reads. A team
 * above whose config does not load adds no mark.
 */
export async function statusLineMeetingFor(runtime: CliRuntime, own: LoadedTeam, claudeSession: string): Promise<StatusLineMeeting | undefined> {
  const shown = own.config.meeting.statusLine;
  if (!shown.enabled) {
    return undefined;
  }
  const now = runtime.clock.now();
  const read = (team: LoadedTeam): Promise<Meeting | undefined> => new MeetingStore(runtime.files, team.kit.paths.meeting).read();
  const ownMeeting = await read(own);
  const above = await Promise.all(((await teamsAboveOf(runtime, own)) ?? []).map(read));
  const tab = phaseOf(ownMeeting, now).kind === 'open' ? await teamSessionOf(runtime, own.kit, await rosterOf(runtime, own.kit, own.config), claudeSession) : undefined;
  return statusLineMeetingOf({ shown, own: ownMeeting, above, now, tab });
}
