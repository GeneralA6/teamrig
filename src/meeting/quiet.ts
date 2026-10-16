import { formatWeekdayMinute } from '../budget/format.ts';
import type { Meeting } from './state.ts';

/**
 * The meeting's quiet window: while the owner meets the lead, a message to the lead waits as an inbox line, as
 * every session was told at the start. Only a message that starts with CRITICAL goes through, for what needs the
 * owner now. The cold-send hook enforces it, so a session that has not read the start notice yet is held too.
 */

/** The word a message to the lead starts with to go through a meeting. */
export const CRITICAL_WORD = 'CRITICAL';

/** Whether a message is the one kind the meeting lets through: its text starts with CRITICAL, in any case. */
export function isCritical(text: string): boolean {
  return new RegExp(`^\\s*${CRITICAL_WORD}\\b`, 'i').test(text);
}

export interface QuietFacts {
  /** The open meeting, if any. */
  readonly meeting: Meeting | undefined;
  /** The receiving session's id, the lead's, and the sending session's (undefined when no team session is known). */
  readonly to: string;
  readonly lead: string;
  readonly from: string | undefined;
  /** The name the lead is messaged by. */
  readonly leadName: string;
  /** The message text; an empty one (a pure idle subscription) wakes no one. */
  readonly text: string;
  /** The command name the note tells the sender to run. */
  readonly command: string;
}

/** The hold's reason, or undefined to let the message go: no open meeting, another receiver, the lead's own send, an empty or CRITICAL message. */
export function quietHoldReason(facts: QuietFacts): string | undefined {
  const { meeting } = facts;
  if (meeting === undefined || facts.to !== facts.lead || facts.from === facts.lead || facts.text.trim() === '' || isCritical(facts.text)) {
    return undefined;
  }
  return (
    `Held: ${facts.leadName} is in the owner's daily meeting since ${formatWeekdayMinute(Date.parse(meeting.startedAt))}. ` +
    `Keep working and leave this as one inbox line, which ${facts.leadName} reads after the meeting: ${facts.command} inbox add --to ${facts.lead} --text "...". ` +
    `Only what needs the owner now goes as a message: start it with ${CRITICAL_WORD}: and send it again.`
  );
}
