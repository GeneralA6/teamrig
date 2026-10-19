import { cut } from "../register/views.js";
import { NOTE_CHARS, oneLine } from "./agenda.js";
import { CRITICAL_WORD } from "./quiet.js";
export function startNotice(facts) {
    return (`the owner's daily meeting with ${facts.leadName} started ${facts.zone.weekdayMinute(new Date(facts.at))}: keep working and send no message to ${facts.leadName} until it ends; ` +
        `leave reports and asks as inbox lines (${facts.command} inbox add --to ${facts.lead} --text "..."). ` +
        `Only what needs the owner now goes as one message starting ${CRITICAL_WORD}:.`);
}
/** The end line, with the decisions recorded on the receiver's tasks during the meeting when there are some. */
export function endNotice(facts, decisions) {
    const decided = decisions.length === 0 ? '' : ` Decided on your tasks: ${decisions.join('; ')}.`;
    return `the owner's daily meeting with ${facts.leadName} ended ${facts.zone.weekdayMinute(new Date(facts.at))}: messages to ${facts.leadName} may go again.${decided}`;
}
/** One decision as the end line gives it: `T7: <note>`, and the fields the lead changed: `T7: <note> (changed priority, due)`. */
export function decisionText(event) {
    const changed = Object.keys(event.changes);
    const note = event.note === null ? '' : ` ${cut(oneLine(event.note), NOTE_CHARS)}`;
    const fields = changed.length === 0 ? '' : ` (changed ${changed.join(', ')})`;
    return `${event.id}:${note}${fields}`;
}
/**
 * The lead's updates during the meeting, by the session that owns each task now: the decisions the lead recorded
 * (a note, a new priority or due date). The lead's own tasks are left out, as are tasks a compaction retired.
 */
export function decisionsByOwner(events, tasks, lead, since) {
    const byOwner = new Map();
    for (const event of events) {
        const owner = tasks.get(event.id)?.owner;
        if (event.type !== 'update' || event.by !== lead || Date.parse(event.at) < since || owner === undefined || owner === lead) {
            continue;
        }
        byOwner.set(owner, [...(byOwner.get(owner) ?? []), decisionText(event)]);
    }
    return byOwner;
}
