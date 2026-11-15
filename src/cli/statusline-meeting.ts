import { MeetingStore, phaseOf } from '../meeting/state.ts';
import { statusLineMeetingOf, type StatusLineMeeting } from '../meeting/status-line.ts';
import { teamSessionOf } from './commands/hook-input.ts';
import { rosterOf } from './kit.ts';
import { rootTeamOf, type LoadedTeam } from './root-team.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The meeting mark of the status line of `claudeSession`, a tab of team `own` (T2513), as the own team's
 * `meeting.statusLine` shows it: undefined with the marks off or no meeting open on the root team. Only a tab of the
 * root team can be the meeting tab, so the tab's session is looked up there alone, and only while a meeting is open,
 * keeping each tick to the meeting file's read.
 */
export async function statusLineMeetingFor(runtime: CliRuntime, own: LoadedTeam, claudeSession: string): Promise<StatusLineMeeting | undefined> {
  const shown = own.config.meeting.statusLine;
  if (!shown.enabled) {
    return undefined;
  }
  const root = await rootTeamOf(runtime, own);
  if (root === undefined) {
    return undefined;
  }
  const now = runtime.clock.now();
  const meeting = await new MeetingStore(runtime.files, root.kit.paths.meeting).read();
  if (phaseOf(meeting, now).kind !== 'open') {
    return undefined;
  }
  const tab = root === own ? await teamSessionOf(runtime, own.kit, await rosterOf(runtime, own.kit, own.config), claudeSession) : undefined;
  return statusLineMeetingOf({ shown, meeting, now, tab });
}
