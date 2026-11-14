import type { KitConfig } from '../../config/types.ts';
import { isRecord, stringField, type JsonRecord } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { cdCompoundFormOf, cdCompoundReason, guardsCdCompound } from '../../hooks/cd-compound.ts';
import { helperOf } from '../../hooks/helper-start.ts';
import { refusalOutput } from '../../hooks/permission.ts';
import { askerOf, guardsPicker, pickerReason, type LeadMeeting, type ParentLead } from '../../hooks/picker-guard.ts';
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
 * Why the guard refuses this payload's question picker (hooks/picker-guard.ts); undefined lets the call go: the
 * switch is off, it is no picker call or no team session asks. The session is read only for a picker call with the
 * switch on, so the tab-status hook's other events read no file, and the team tree and the meeting, which only pick
 * the reason, only for the lead's own thread.
 */
export async function pickerRefusal(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: JsonRecord): Promise<string | undefined> {
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
  const meeting: LeadMeeting = { open: asker.role === 'lead' && (await meetingOpen(runtime, kit)) };
  return pickerReason(KIT_NAME, asker, meeting);
}

/**
 * Why the guard refuses this payload's Bash `cd` compound (hooks/cd-compound.ts); undefined lets the line go: the
 * switch is off, the line needs no rerun or has no rerun form, or no team session runs it.
 */
async function cdCompoundRefusal(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: JsonRecord, form: string): Promise<string | undefined> {
  if (!config.pickerGuard.enabled) {
    return undefined;
  }
  const session = await teamSessionOf(runtime, kit, await rosterOf(runtime, kit, config), sessionIdOf(payload));
  return session === undefined ? undefined : cdCompoundReason(form);
}

/** What the hook prints for this payload: the refusal with its reason, or '' when the call goes on. */
async function pickerGuardOutputOf(runtime: CliRuntime, payload: JsonRecord): Promise<string> {
  // Every Bash line reaches this hook, so a line with no cd compound to rerun returns before any file is read.
  const bash = guardsCdCompound(true, payload);
  const form = bash ? cdCompoundFormOf(payload, { cwd: stringField(payload, 'cwd') ?? runtime.cwd, home: runtime.userHome }) : undefined;
  if (bash && form === undefined) {
    return '';
  }
  const found = await sessionTeam(payload, runtime);
  const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
  if (kit?.load.status !== 'loaded') {
    return '';
  }
  const config = kit.load.config;
  const reason = form === undefined ? await pickerRefusal(runtime, kit, config, payload) : await cdCompoundRefusal(runtime, kit, config, payload, form);
  return reason === undefined ? '' : refusalOutput(reason);
}

/**
 * PreToolUse on AskUserQuestion and Bash, with `pickerGuard.enabled`. On AskUserQuestion it refuses the question
 * picker in every team session and every helper, the lead's own thread and a sub-team's lead included, with a reason
 * that says to decide it if it is the caller's own, else record it as a decision card (a sub-team's lead also tells its
 * parent lead) and go on with the next task; the lead in the owner's daily meeting is told to ask the card in plain
 * text. On Bash it refuses a team session's line that leads with `cd D &&` and runs git or leaves the session's folder,
 * which Claude Code would hold on a permission prompt, quoting its git -C / env -C rerun form (T2730). Outside a team,
 * with the guard off, for a tab that is no team session, input that is not a hook payload or on any error, it prints
 * nothing, so the call goes on.
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
