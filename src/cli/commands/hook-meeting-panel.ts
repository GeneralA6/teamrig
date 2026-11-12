import { askedDecisions } from '../../meeting/agenda.ts';
import { meetingPanelOf, type MeetingPanel } from '../../meeting/panel.ts';
import { inMeeting, MeetingStore } from '../../meeting/state.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { subtreeOf } from '../roll-up.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { parseJson } from './hook-input.ts';
import { wakeScopeOf } from './hook-wake.ts';
import { decidedByOf, decisionAgendaOf } from './meeting-registers.ts';

/**
 * What `hook meeting-panel` answers the plugin's mod, one JSON line: the agenda panel of the open meeting, and the
 * files whose change asks again (the meeting file and each register the meeting covers); or no panel in this tab
 * (`why`), asked again once a file in `watch` changes (the meeting file in the lead's tab, nothing in another).
 */
export type MeetingPanelAnswer =
  | ({ readonly kind: 'open'; readonly watch: readonly string[] } & MeetingPanel)
  | { readonly kind: 'off'; readonly why: string; readonly watch: readonly string[] };

function answer(runtime: CliRuntime, value: MeetingPanelAnswer): ExitCode {
  runtime.out.stdout(JSON.stringify(value));
  return EXIT.ok;
}

/**
 * `hook meeting-panel`, run by the mod's meeting panel hand in a team session's tab (T2512). It shows only in the tab
 * of a root team's lead, the one that meets the owner, while the meeting it started is open, and only with
 * `meeting.panel.enabled`: the owner's cards of the lead's register and of every team under it, as the agenda asks
 * them, the ones decided since the start checked off (meetingPanelOf). It reads and writes nothing else.
 */
export async function meetingPanel(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const scope = await wakeScopeOf(runtime, parseJson(await runtime.readStdin()), false);
  if (scope.kind === 'off') {
    return answer(runtime, { ...scope, watch: [] });
  }
  const { kit, config, roster, id } = scope;
  if (!config.meeting.panel.enabled) {
    return answer(runtime, { kind: 'off', why: 'meeting.panel.enabled is false', watch: [] });
  }
  if (roster.holderOf('lead') !== id) {
    return answer(runtime, { kind: 'off', why: 'only the lead meets the owner', watch: [] });
  }
  const kitTree = await loadTree(runtime);
  if (kitTree.tree.ownerLeadAbove(kit.paths.team) !== undefined) {
    return answer(runtime, { kind: 'off', why: 'a team under another meets no owner', watch: [] });
  }
  const now = runtime.clock.now();
  const meeting = await new MeetingStore(runtime.files, kit.paths.meeting).read();
  if (meeting === undefined || !inMeeting(meeting, id, now)) {
    return answer(runtime, { kind: 'off', why: 'no meeting is open', watch: [kit.paths.meeting] });
  }
  const rollUp = await subtreeOf(runtime, { kit, config, roster }, kitTree);
  const { own, teams } = rollUp;
  const panel = meetingPanelOf({
    meeting,
    registers: teams.map((rolled) => ({
      team: rolled.team === own.team ? undefined : rolled.team,
      tasks: [...rolled.snapshot.state.tasks.values()],
      decidedBy: decidedByOf(rolled, own, id),
    })),
    asked: askedDecisions(decisionAgendaOf(rollUp, runtime, now)),
    ownerMarker: config.register.ownerSource,
  });
  return answer(runtime, { kind: 'open', ...panel, watch: [kit.paths.meeting, ...teams.map((rolled) => rolled.paths.events)] });
}
