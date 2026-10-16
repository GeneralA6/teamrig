import { formatWeekdayMinute } from '../budget/format.ts';
import type { RegisterEvent, UpdateEvent } from '../register/events.ts';
import type { Task } from '../register/fold.ts';
import { cut } from '../register/views.ts';
import { NOTE_CHARS, oneLine } from './agenda.ts';
import { CRITICAL_WORD } from './quiet.ts';

/**
 * What the meeting tells the other sessions, one inbox line each: an inbox line wakes no one, where a message would
 * wake every idle session cold. The cold-send hook holds a message to the lead all the same (quiet.ts), so a
 * session that has not read the start line yet is held too.
 */

export interface NoticeFacts {
  /** The lead's session id and the name it is messaged by. */
  readonly lead: string;
  readonly leadName: string;
  readonly at: number;
  readonly command: string;
}

export function startNotice(facts: NoticeFacts): string {
  return (
    `the owner's daily meeting with ${facts.leadName} started ${formatWeekdayMinute(facts.at)}: keep working and send no message to ${facts.leadName} until it ends; ` +
    `leave reports and asks as inbox lines (${facts.command} inbox add --to ${facts.lead} --text "..."). ` +
    `Only what needs the owner now goes as one message starting ${CRITICAL_WORD}:.`
  );
}

/** The end line, with the decisions recorded on the receiver's tasks during the meeting when there are some. */
export function endNotice(facts: NoticeFacts, decisions: readonly string[]): string {
  const decided = decisions.length === 0 ? '' : ` Decided on your tasks: ${decisions.join('; ')}.`;
  return `the owner's daily meeting with ${facts.leadName} ended ${formatWeekdayMinute(facts.at)}: messages to ${facts.leadName} may go again.${decided}`;
}

/** One decision as the end line gives it: `T7: <note>`, and the fields the lead changed: `T7: <note> (changed priority, due)`. */
export function decisionText(event: UpdateEvent): string {
  const changed = Object.keys(event.changes);
  const note = event.note === null ? '' : ` ${cut(oneLine(event.note), NOTE_CHARS)}`;
  const fields = changed.length === 0 ? '' : ` (changed ${changed.join(', ')})`;
  return `${event.id}:${note}${fields}`;
}

/**
 * The lead's updates during the meeting, by the session that owns each task now: the decisions the lead recorded
 * (a note, a new priority or due date). The lead's own tasks are left out, as are tasks a compaction retired.
 */
export function decisionsByOwner(events: readonly RegisterEvent[], tasks: ReadonlyMap<string, Task>, lead: string, since: number): Map<string, string[]> {
  const byOwner = new Map<string, string[]>();
  for (const event of events) {
    const owner = tasks.get(event.id)?.owner;
    if (event.type !== 'update' || event.by !== lead || Date.parse(event.at) < since || owner === undefined || owner === lead) {
      continue;
    }
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), decisionText(event)]);
  }
  return byOwner;
}
