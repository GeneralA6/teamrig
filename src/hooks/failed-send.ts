import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { sendTargetOf } from './cold-send.ts';

/**
 * The failed-send hook, PostToolUse on SendMessage. A send to a name no live session answers to (a
 * remembered pipe, an old name, a session that has exited) does not fail the tool: it returns
 * `success: false`, and the message is lost unless the sender writes it down. The model gets one line
 * after that result: leave the message as an inbox line, which waits for the receiver's next prompt.
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
  const response = responseOf(payload['tool_response']);
  if (response === undefined || response['success'] !== false) {
    return undefined;
  }
  const reason = stringField(response, 'message')?.split('\n')[0]?.trim();
  return { to, reason: reason === undefined || reason === '' ? 'not delivered' : reason };
}

/** The tool's result as a record: Claude Code may hand it over as the object or as its JSON text. */
function responseOf(value: unknown): JsonRecord | undefined {
  if (typeof value !== 'string') {
    return isRecord(value) ? value : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The line for the model: where the message goes now. `id` is the team session `failed.to` names; for a
 * name that is no team session the line points to `who`, which prints the names to message by.
 */
export function failedSendLine(failed: FailedSend, id: string | undefined, command: string): string {
  const next =
    id === undefined
      ? `${failed.to} is no team session name (\`${command} who\` prints them); for a team session, leave it as an inbox line: \`${command} inbox add --to <area> --text "..."\`.`
      : `leave it as an inbox line, shown at ${id}'s next prompt: \`${command} inbox add --to ${id} --text "..."\`.`;
  return `${command}: the message to ${failed.to} was not sent (${failed.reason}); ${next}`;
}

/** The hook's stdout: the line as context for the model after the tool's result. */
export function failedSendOutput(line: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: line } });
}
