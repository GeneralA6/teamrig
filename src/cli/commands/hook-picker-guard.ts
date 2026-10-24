import type { KitConfig } from '../../config/types.ts';
import { isRecord, type JsonRecord } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { helperOf } from '../../hooks/helper-start.ts';
import { askerOf, guardsPicker, pickerGuardOutput, pickerReason, refusesAsker, type ParentLead, type PickerAsker } from '../../hooks/picker-guard.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { MeetingStore, phaseOf } from '../../meeting/state.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit, rosterOf, type Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { parseJson, sessionTeam, teamSessionOf } from './hook-input.ts';

/** Whether the owner's daily meeting is open now (src/meeting/state.ts). */
async function meetingOpen(runtime: CliRuntime, kit: Kit): Promise<boolean> {
  return phaseOf(await new MeetingStore(runtime.files, kit.paths.meeting).read(), runtime.clock.now()).kind === 'open';
}

/**
 * The team's parent lead when its config names a parent team, read from every team config (cli/tree.ts); undefined
 * for a team with no parent, or one whose parent has no config, which `doctor` names and the guard treats as a root.
 */
async function parentLeadOf(runtime: CliRuntime, kit: Kit, config: KitConfig): Promise<ParentLead | undefined> {
  if (config.team?.parent === undefined) {
    return undefined;
  }
  const { tree } = await loadTree(runtime);
  return tree.placeOf(kit.paths.team)?.parentLead;
}

/**
 * Who the guard refuses the question picker to (hooks/picker-guard.ts); undefined lets the call go. The session is
 * read only for a picker call with the switch on, so the tab-status hook's other events read no file, and the
 * team tree and the meeting only for the lead's own thread.
 */
export async function refusedPickerAsker(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: JsonRecord): Promise<PickerAsker | undefined> {
  if (!guardsPicker(config.pickerGuard.enabled, payload)) {
    return undefined;
  }
  const session = await teamSessionOf(runtime, kit, await rosterOf(runtime, kit, config), sessionIdOf(payload));
  const helper = helperOf(payload) !== undefined;
  const lead = config.roles.lead;
  const asker = askerOf(session, helper, lead, !helper && session === lead ? await parentLeadOf(runtime, kit, config) : undefined);
  if (asker === undefined) {
    return undefined;
  }
  return refusesAsker(asker, asker.role === 'lead' && (await meetingOpen(runtime, kit))) ? asker : undefined;
}

/** What the hook prints for this payload: the refusal with its reason, or '' when the picker opens. */
async function pickerGuardOutputOf(runtime: CliRuntime, payload: JsonRecord): Promise<string> {
  const found = await sessionTeam(payload, runtime);
  const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
  if (kit?.load.status !== 'loaded') {
    return '';
  }
  const asker = await refusedPickerAsker(runtime, kit, kit.load.config, payload);
  return asker === undefined ? '' : pickerGuardOutput(pickerReason(KIT_NAME, asker));
}

/**
 * PreToolUse on AskUserQuestion: with `pickerGuard.enabled`, refuses the question picker in every team session and
 * every helper, the lead's own thread too unless the owner's daily meeting is open, and a sub-team's lead always,
 * with a reason that says to decide it if it is the caller's own, else record it as a decision card (a sub-team's
 * lead also tells its parent lead) and go on with the next task. Outside a
 * team, with the guard off, for the lead in a meeting, a tab that is no team session, input that is not a hook
 * payload or on any error, it prints nothing, so the picker opens.
 */
export async function pickerGuard(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const output = isRecord(payload) ? await pickerGuardOutputOf(runtime, payload).catch(() => '') : '';
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}
