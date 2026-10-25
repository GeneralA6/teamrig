import { isRecord, stringField } from '../core/guards.ts';
import { isReservedName, RESERVED_RULE } from '../core/ids.ts';
import { sendTargetOf } from './cold-send.ts';
import { toolResponseOf } from './post-tool-use.ts';

/**
 * The failed-send hook, PostToolUse on SendMessage. A send to a name no live session answers to (a
 * remembered pipe, an old name, a session that has exited) does not fail the tool: it returns
 * `success: false`, and the message is lost unless the sender writes it down. The model gets one line
 * after that result: leave the message as an inbox line, which waits for the receiver's next prompt, or with
 * wakes on wakes it when marked `--wake now`.
 */

/** A SendMessage call whose message was not delivered: the receiver it named and the first line of why. */
export interface FailedSend {
  readonly to: string;
  readonly reason: string;
}

/** The failed send a PostToolUse payload reports; undefined for any other tool or a delivered message. */
export function failedSendOf(payload: unknown): FailedSend | undefined {
  const to = sendTargetOf(payload);
  if (to === undefined || !isRecord(payload)) {
    return undefined;
  }
  const response = toolResponseOf(payload['tool_response']);
  if (response === undefined || response['success'] !== false) {
    return undefined;
  }
  const reason = stringField(response, 'message')?.split('\n')[0]?.trim();
  return { to, reason: reason === undefined || reason === '' ? 'not delivered' : reason };
}

/**
 * The line for the model: where the message goes now. `id` is the team session `failed.to` names; for a
 * name that is no team session the line points to `who`, which prints the names to message by. For a name Claude
 * Code reserves (T1124) it also says why, so the sender stops messaging it. With `wakeNow` (the team's
 * `wake.enabled`) the line also offers `--wake now`, for a receiver that must act on it now.
 */
export function failedSendLine(failed: FailedSend, id: string | undefined, command: string, wakeNow: boolean): string {
  const urgent = wakeNow ? `, or with \`--wake now\` if ${id ?? 'it'} must act on it now` : '';
  const next =
    id === undefined
      ? `${failed.to} is no team session name (\`${command} who\` prints them); for a team session, leave it as an inbox line: \`${command} inbox add --to <area> --text "..."\`${urgent}.`
      : `leave it as an inbox line, shown at ${id}'s next prompt: \`${command} inbox add --to ${id} --text "..."\`${urgent}.`;
  const never = isReservedName(failed.to) ? ` ${failed.to} ${RESERVED_RULE}.` : '';
  return `${command}: the message to ${failed.to} was not sent (${failed.reason}); ${next}${never}`;
}
