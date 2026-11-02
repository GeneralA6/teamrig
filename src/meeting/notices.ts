import type { TimeZone } from '../core/zone.ts';
import type { RegisterEvent, UpdateEvent } from '../register/events.ts';
import type { Task } from '../register/fold.ts';
import { cut } from '../register/views.ts';
import { NOTE_CHARS, oneLine } from './agenda.ts';

/**
 * What the meeting tells the other sessions: at its end, one inbox line to each session with a decision recorded on
 * its tasks, and nothing to the rest. These lines carry no wake ask, so they wake no one, where a message would wake
 * an idle session cold.
 * The start tells no one: the cold-send hook holds a message to the lead when it is sent, and its reason says what
 * to do instead (quiet.ts).
 */

export interface NoticeFacts {
  /** The name the lead is messaged by, and when the meeting ended. */
  readonly leadName: string;
  readonly at: number;
  /** The team's clock, which the lines' times are on. */
  readonly zone: TimeZone;
}

/** The end line to a session with decisions recorded on its tasks during the meeting. */
export function endNotice(facts: NoticeFacts, decisions: readonly string[]): string {
  return `the owner's daily meeting with ${facts.leadName} ended ${facts.zone.weekdayMinute(new Date(facts.at))}. Decided on your tasks: ${decisions.join('; ')}.`;
}

/**
 * One decision as the end line gives it: `T7: <note>`, the fields the lead changed: `T7: <note> (changed priority,
 * due)`, and a Decided (T1366), which drops the task's wait on the owner, saying its owner acts on it now.
 */
export function decisionText(event: UpdateEvent): string {
  const changed = Object.keys(event.changes);
  const note = event.note === null ? '' : ` ${cut(oneLine(event.note), NOTE_CHARS)}`;
  const fields = changed.length === 0 ? '' : ` (changed ${changed.join(', ')})`;
  const decided = event.decided === true ? ' (its wait on the owner cleared: act on it, set its next status)' : '';
  return `${event.id}:${note}${fields}${decided}`;
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
