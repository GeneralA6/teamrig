import type { KitConfig } from '../config/types.ts';
import { MeetingStore, phaseOf } from '../meeting/state.ts';
import { statusLineMeetingOf, type StatusLineMeeting } from '../meeting/status-line.ts';
import { teamSessionOf } from './commands/hook-input.ts';
import { openKit, rosterOf, type Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';

/** A team's opened kit with its loaded config. */
export interface LoadedTeam {
  readonly kit: Kit;
  readonly config: KitConfig;
}

/**
 * The root of the tree `own` sits in, up its `team.parent` links: the owner meets only the root team's lead. Undefined
 * when a config on the way does not load; a loop of parent links ends at the last team before the first one met again.
 */
async function rootTeamOf(runtime: CliRuntime, own: LoadedTeam): Promise<LoadedTeam | undefined> {
  const seen = new Set<string>([own.kit.paths.team]);
  let current = own;
  for (let parent = own.config.team?.parent; parent !== undefined && !seen.has(parent); parent = current.config.team?.parent) {
    seen.add(parent);
    const kit = await openKit(runtime, parent);
    if (kit.load.status !== 'loaded') {
      return undefined;
    }
    current = { kit, config: kit.load.config };
  }
  return current;
}

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
