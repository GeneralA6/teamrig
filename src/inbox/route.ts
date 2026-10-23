import type { LeadTree } from '../config/lead-tree.ts';
import { CRITICAL_WORD, isCritical } from '../meeting/quiet.ts';

/**
 * The route reminder (T783): a leader may still message a session under one of its sub-leads directly, and the message
 * goes, but the sender is told in one line to route such work via the sub-lead it skipped. An urgent incident, a
 * message that starts with CRITICAL, stays direct and gets no reminder.
 */

/** A message from one team session to another, by session id. */
export interface TeamMessage {
  readonly from: string;
  readonly to: string;
  readonly text: string;
}

/**
 * The reminder for a message, or undefined when it skips no sub-lead, is urgent or is empty (a pure idle subscription
 * carries no work). `nameOf` names a session the way the sender addresses it: its message name after a SendMessage,
 * its id after an inbox line.
 */
export function routeReminderOf(tree: LeadTree, message: TeamMessage, nameOf: (id: string) => string, command: string): string | undefined {
  const via = tree.routeVia(message.from, message.to);
  if (via === undefined || message.text.trim() === '' || isCritical(message.text)) {
    return undefined;
  }
  const subLead = nameOf(via);
  return `${command}: ${nameOf(message.to)} works under ${subLead}: route such work via ${subLead} next time; an urgent incident (a message starting ${CRITICAL_WORD}) stays direct.`;
}
