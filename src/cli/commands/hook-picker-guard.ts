import type { KitConfig } from '../../config/types.ts';
import { isRecord, type JsonRecord } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { cdCompoundOfEvent, cdCompoundReason, guardsCdCompound, type CdCompound } from '../../hooks/cd-compound.ts';
import { helperOf } from '../../hooks/helper-start.ts';
import { refusal } from '../../hooks/permission.ts';
import { askerOf, guardsPicker, pickerReason, type LeadMeeting, type ParentLead } from '../../hooks/picker-guard.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { MeetingSchedule, meetingInTabOf } from '../../meeting/schedule.ts';
import { MeetingStore, phaseOf } from '../../meeting/state.ts';
import type { HookEvent, HookReply } from '../../ports/host/index.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit, rosterOf, type Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { loadTree } from '../tree.ts';
import { readHookInput, sessionTeam, teamSessionOf, writeReply } from './hook-input.ts';

/**
 * Whether the owner's daily meeting is open now (src/meeting/state.ts). An unreadable meeting file reads as closed:
 * the meeting only picks the refusal's reason, so the guard refuses the picker either way (T3015).
 */
async function meetingOpen(runtime: CliRuntime, kit: Kit): Promise<boolean> {
  try {
    return phaseOf(await new MeetingStore(runtime.files, kit.paths.meeting).read(), runtime.clock.now()).kind === 'open';
  } catch {
    return false;
  }
}

/**
 * The id of the meeting held in `session`'s tab now (src/meeting/schedule.ts), else undefined. An unreadable schedule
 * reads as no meeting, as `meetingOpen` does, so the guard refuses the picker either way (T3015).
 */
async function meetingInTab(runtime: CliRuntime, kit: Kit, session: string): Promise<string | undefined> {
  try {
    return meetingInTabOf((await new MeetingSchedule(runtime.files, kit.paths.meetings).read()).meetings, session, runtime.clock.now())?.id;
  } catch {
    return undefined;
  }
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
  const inTab = asker.role === 'helper' ? undefined : await meetingInTab(runtime, kit, asker.session);
  const meeting: LeadMeeting = { open: (asker.role === 'lead' || asker.role === 'subteam-lead') && (await meetingOpen(runtime, kit)), inTab };
  return pickerReason(KIT_NAME, asker, meeting);
}

/**
 * Why the guard refuses this event's Bash `cd` compound (hooks/cd-compound.ts); undefined lets the line go: the
 * switch is off, the line has no cd compound Claude Code asks about, or no team session runs it.
 */
async function cdCompoundRefusal(runtime: CliRuntime, kit: Kit, config: KitConfig, event: HookEvent, compound: CdCompound): Promise<string | undefined> {
  if (!config.pickerGuard.enabled) {
    return undefined;
  }
  const session = await teamSessionOf(runtime, kit, await rosterOf(runtime, kit, config), event.session ?? null);
  return session === undefined ? undefined : cdCompoundReason(compound);
}

/** The hook's reply to this call: the refusal with its reason, or none when the call goes on. */
async function pickerGuardReplyOf(runtime: CliRuntime, payload: JsonRecord, event: HookEvent): Promise<HookReply | undefined> {
  // Every Bash line reaches this hook, so a line with no cd compound to refuse returns before any file is read.
  const bash = guardsCdCompound(true, event);
  const compound = bash ? cdCompoundOfEvent(event, { cwd: event.cwd ?? runtime.cwd, home: runtime.userHome }) : undefined;
  if (bash && compound === undefined) {
    return undefined;
  }
  const found = await sessionTeam(payload, runtime);
  const kit = found.kind === 'team' ? await openKit(runtime, found.team) : undefined;
  if (kit?.load.status !== 'loaded') {
    return undefined;
  }
  const config = kit.load.config;
  const reason = compound === undefined ? await pickerRefusal(runtime, kit, config, payload) : await cdCompoundRefusal(runtime, kit, config, event, compound);
  return reason === undefined ? undefined : refusal(reason);
}

/**
 * PreToolUse on AskUserQuestion and Bash, with `pickerGuard.enabled`. On AskUserQuestion it refuses the question
 * picker in every team session and every helper, the lead's own thread and a sub-team's lead included, with a reason
 * that says to decide it if it is the caller's own, else record it as a decision card (a sub-team's lead also tells its
 * parent lead) and go on with the next task; the lead in the owner's daily meeting is told to ask the card in plain
 * text. On Bash it refuses a team session's line with a `cd` that runs git or leaves the session's folder, which Claude
 * Code would hold on a permission prompt, quoting its git -C / env -C rerun form (T2730), or with none, saying to drop
 * the `cd` (T2802). Outside a team,
 * with the guard off, for a tab that is no team session, input that is not a hook payload or on any error, it prints
 * nothing, so the call goes on.
 */
export async function pickerGuard(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { payload, event } = await readHookInput(runtime);
  const reply = isRecord(payload) && event !== undefined ? await pickerGuardReplyOf(runtime, payload, event).catch(() => undefined) : undefined;
  writeReply(runtime, 'tool-start', reply);
  return EXIT.ok;
}
