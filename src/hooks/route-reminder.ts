import type { HookEvent } from '../ports/host/index.ts';
import { sentMessageOf } from './cold-send.ts';
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

/** The delivered send the event of a finished call reports; undefined for a call of any other kind, a send that failed or a result it cannot read. */
export function deliveredSendOf(event: HookEvent): DeliveredSend | undefined {
  const sent = sentMessageOf(event);
  if (sent === undefined) {
    return undefined;
  }
  return toolResponseOf(event.call?.response)?.['success'] === true ? { to: sent.to, text: sent.text } : undefined;
}
