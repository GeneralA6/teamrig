import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { askedDecisions, bookedDecisions } from '../../meeting/agenda.ts';
import { meetingPanelOf, type MeetingPanel } from '../../meeting/panel.ts';
import { bookedMeetingOf, MeetingSchedule, type ScheduledMeeting } from '../../meeting/schedule.ts';
import { inMeeting, MeetingStore } from '../../meeting/state.ts';
import type { TaskTree } from '../../register/tree.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import type { Kit } from '../kit.ts';
import { subtreeOf } from '../roll-up.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { readHookInput } from './hook-input.ts';
import { wakeScopeOf } from './hook-wake.ts';
import { agendaRegisterOf, decidedByOf, decisionAgendaOf } from './meeting-registers.ts';

/**
 * What `hook meeting-panel` answers the plugin's mod, one JSON line: the agenda panel of the open meeting, and the
 * files whose change asks again (the meeting files and each register the meeting covers); or no panel in this tab
 * (`why`), asked again once a file in `watch` changes (the booked meetings file in every team session's tab, the
 * daily meeting file too in the lead's).
 */
export type MeetingPanelAnswer =
  | ({ readonly kind: 'open'; readonly watch: readonly string[] } & MeetingPanel)
  | { readonly kind: 'off'; readonly why: string; readonly watch: readonly string[] };

function answer(runtime: CliRuntime, value: MeetingPanelAnswer): ExitCode {
  runtime.out.stdout(JSON.stringify(value));
  return EXIT.ok;
}

/** The ids a booked meeting covers: its tasks and every task they need first, directly or not, each once. */
export function bookedTaskIds(tasks: readonly string[], tree: Pick<TaskTree, 'needs'>): Set<string> {
  const found = new Set<string>();
  const queue = [...tasks];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (!found.has(next)) {
      found.add(next);
      queue.push(...tree.needs(next));
    }
  }
  return found;
}

interface PanelScope {
  readonly kit: Kit;
  readonly config: KitConfig;
  readonly roster: Roster;
  readonly id: string;
}

/**
 * The panel of a booked meeting started in this tab's session (T2808), in any team: the owner's cards among the
 * meeting's tasks and those they need, of the session's own register, as bookedDecisions asks them, the ones the
 * session recorded a decision on since the start checked off.
 */
async function bookedPanel(runtime: CliRuntime, { kit, config, roster, id }: PanelScope, booked: ScheduledMeeting): Promise<MeetingPanelAnswer> {
  const { own } = await subtreeOf(runtime, { kit, config, roster }, await loadTree(runtime));
  const register = agendaRegisterOf(own, runtime);
  const ids = bookedTaskIds(booked.tasks, register.tree);
  const tasks = register.tasks.filter((task) => ids.has(task.id));
  const panel = meetingPanelOf({
    meeting: { startedAt: new Date(booked.changedAt).toISOString() },
    registers: [{ team: undefined, tasks, decidedBy: id }],
    asked: bookedDecisions({ ...register, tasks }),
    ownerMarker: config.register.ownerSource,
  });
  return { kind: 'open', ...panel, watch: [kit.paths.meetings, own.paths.events] };
}

/**
 * `hook meeting-panel`, run by the mod's meeting panel hand in a team session's tab (T2512), only with
 * `meeting.panel.enabled`. A booked meeting (`meeting start M<n>`) started in this session's tab shows its own cards
 * (bookedPanel, T2808). Otherwise it shows only in the tab of a team's lead, a sub-team's too (T2985), while the
 * meeting it started is open: the owner's cards of the lead's register and of every team under it, as the agenda asks
 * them, the ones decided since the start checked off (meetingPanelOf). It reads and writes nothing else.
 */
export async function meetingPanel(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const scope = await wakeScopeOf(runtime, (await readHookInput(runtime)).event, false);
  if (scope.kind === 'off') {
    return answer(runtime, { ...scope, watch: [] });
  }
  const { kit, config, roster, id } = scope;
  if (!config.meeting.panel.enabled) {
    return answer(runtime, { kind: 'off', why: 'meeting.panel.enabled is false', watch: [] });
  }
  const now = runtime.clock.now();
  const { meetings } = await new MeetingSchedule(runtime.files, kit.paths.meetings).read();
  const booked = bookedMeetingOf(
    meetings.filter((meeting) => meeting.session === id),
    id,
    now,
  );
  if (booked !== undefined) {
    return answer(runtime, await bookedPanel(runtime, { kit, config, roster, id }, booked));
  }
  if (roster.holderOf('lead') !== id) {
    return answer(runtime, { kind: 'off', why: 'no meeting of yours is started', watch: [kit.paths.meetings] });
  }
  const meeting = await new MeetingStore(runtime.files, kit.paths.meeting).read();
  if (meeting === undefined || !inMeeting(meeting, id, now)) {
    return answer(runtime, { kind: 'off', why: 'no meeting is open', watch: [kit.paths.meeting, kit.paths.meetings] });
  }
  const rollUp = await subtreeOf(runtime, { kit, config, roster }, await loadTree(runtime));
  const { own, teams } = rollUp;
  const panel = meetingPanelOf({
    meeting,
    registers: teams.map((rolled) => ({
      team: rolled.team === own.team ? undefined : rolled.team,
      tasks: [...rolled.snapshot.state.tasks.values()],
      decidedBy: decidedByOf(rolled, own, id),
    })),
    asked: askedDecisions(decisionAgendaOf(rollUp, runtime, now, meeting.carried)),
    ownerMarker: config.register.ownerSource,
  });
  return answer(runtime, { kind: 'open', ...panel, watch: [kit.paths.meeting, kit.paths.meetings, ...teams.map((rolled) => rolled.paths.events)] });
}
