import { isRecord } from '../core/guards.ts';
import { sendTargetOf, sendTextOf } from './cold-send.ts';
import { toolResponseOf } from './post-tool-use.ts';

/**
 * The route-reminder hook, PostToolUse on SendMessage (T783). A message a leader sends past one of its sub-leads is
 * delivered; after it, the model gets one line to route such work via that sub-lead next time (inbox/route.ts). Only a
 * delivered send counts: a failed one is the failed-send hook's.
 */

/** A SendMessage call whose message was delivered: the receiver it named and the text it sent. */
export interface DeliveredSend {
  readonly to: string;
  readonly text: string;
}

/** The delivered send a PostToolUse payload reports; undefined for any other tool, a send that failed or a result it cannot read. */
export function deliveredSendOf(payload: unknown): DeliveredSend | undefined {
  const to = sendTargetOf(payload);
  if (to === undefined || !isRecord(payload)) {
    return undefined;
  }
  const response = toolResponseOf(payload['tool_response']);
  return response?.['success'] === true ? { to, text: sendTextOf(payload) } : undefined;
}
