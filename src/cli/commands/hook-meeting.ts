import type { Roster } from '../../config/roster.ts';
import { KIT_NAME } from '../../core/home.ts';
import { holdOutput, sendTargetOf, sendTextOf } from '../../hooks/cold-send.ts';
import { quietHoldReason } from '../../meeting/quiet.ts';
import { MeetingStore, phaseOf } from '../../meeting/state.ts';
import type { Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { teamSessionOf } from './hook-input.ts';

/**
 * The meeting's hold for a SendMessage call, as the cold-send hook's stdout; undefined lets the message go. While
 * the owner's daily meeting is open, a message to the lead from any other session waits as an inbox line, but one
 * starting CRITICAL (src/meeting/quiet.ts). Unlike the cold hold, a resend does not pass it.
 */
export async function meetingHold(runtime: CliRuntime, kit: Kit, roster: Roster, payload: unknown, claudeSession: string): Promise<string | undefined> {
  const to = sendTargetOf(payload);
  const lead = roster.holderOf('lead');
  const receiver = to === undefined ? undefined : roster.lookup(to);
  if (lead === undefined || receiver?.ok !== true || receiver.id !== lead) {
    return undefined;
  }
  const phase = phaseOf(await new MeetingStore(runtime.files, kit.paths.meeting).read(), runtime.clock.now());
  if (phase.kind !== 'open') {
    return undefined;
  }
  const reason = quietHoldReason({
    meeting: phase.meeting,
    to: receiver.id,
    lead,
    from: await teamSessionOf(runtime, kit, roster, claudeSession),
    leadName: roster.nameOf(lead) ?? lead,
    text: sendTextOf(payload),
    command: KIT_NAME,
  });
  return reason === undefined ? undefined : holdOutput(reason);
}
