import type { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { errorMessage } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { sendTargetOf, sendTextOf } from '../../hooks/cold-send.ts';
import { refusalOutput } from '../../hooks/permission.ts';
import { recordBreakthrough, type Breakthrough } from '../../meeting/breakthrough.ts';
import { bookedHoldReason, isBreakthrough, quietHoldReason, type QuietFacts } from '../../meeting/quiet.ts';
import { MeetingSchedule, meetingInTabOf } from '../../meeting/schedule.ts';
import { MeetingStore, phaseOf, type Meeting } from '../../meeting/state.ts';
import { teamZone, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { teamSessionOf } from './hook-input.ts';

/**
 * The meeting's hold for a SendMessage call, as the cold-send hook's stdout; undefined lets the message go. While
 * the owner's daily meeting is open, a message to the lead from any other session waits as an inbox line, but one
 * starting CRITICAL (src/meeting/quiet.ts); so does one to any session the owner meets in its own tab, in a booked or
 * on-the-spot meeting (T2985). Unlike the cold hold, a resend does not pass it.
 */
export async function meetingHold(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, payload: unknown, claudeSession: string): Promise<string | undefined> {
  const to = sendTargetOf(payload);
  const receiver = to === undefined ? undefined : roster.lookup(to);
  if (receiver?.ok !== true) {
    return undefined;
  }
  const lead = roster.holderOf('lead');
  if (lead !== undefined && receiver.id === lead) {
    const phase = phaseOf(await new MeetingStore(runtime.files, kit.paths.meeting).read(), runtime.clock.now());
    if (phase.kind === 'open') {
      return dailyHold(runtime, kit, config, roster, payload, claudeSession, lead, phase.meeting);
    }
  }
  const meeting = meetingInTabOf((await new MeetingSchedule(runtime.files, kit.paths.meetings).read()).meetings, receiver.id, runtime.clock.now());
  if (meeting === undefined) {
    return undefined;
  }
  const reason = bookedHoldReason({
    meeting,
    to: receiver.id,
    toName: roster.nameOf(receiver.id) ?? receiver.id,
    from: await teamSessionOf(runtime, kit, roster, claudeSession),
    text: sendTextOf(payload),
    command: KIT_NAME,
    zone: teamZone(config, runtime),
  });
  return reason === undefined ? undefined : refusalOutput(reason);
}

/** The open daily meeting's hold of a message to the lead, which records a CRITICAL one as its break-through (T2524). */
async function dailyHold(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, payload: unknown, claudeSession: string, lead: string, meeting: Meeting): Promise<string | undefined> {
  const facts: QuietFacts = {
    meeting,
    to: lead,
    lead,
    from: await teamSessionOf(runtime, kit, roster, claudeSession),
    leadName: roster.nameOf(lead) ?? lead,
    text: sendTextOf(payload),
    command: KIT_NAME,
    zone: teamZone(config, runtime),
  };
  if (isBreakthrough(facts)) {
    await noteBreakthrough(runtime, kit, { startedAt: meeting.startedAt, atMs: runtime.clock.now(), from: facts.from ?? null });
  }
  const reason = quietHoldReason(facts);
  return reason === undefined ? undefined : refusalOutput(reason);
}

/** Records the break-through for the spotlight; a failed write only says so, as the message goes either way. */
async function noteBreakthrough(runtime: CliRuntime, kit: Kit, breakthrough: Breakthrough): Promise<void> {
  try {
    await recordBreakthrough(runtime.files, kit.paths.meetingBreakthrough, breakthrough);
  } catch (error) {
    runtime.out.stderr(`${KIT_NAME}: the spotlight stays on, as the break-through could not be recorded: ${errorMessage(error)}`);
  }
}
