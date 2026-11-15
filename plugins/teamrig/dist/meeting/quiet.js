/**
 * The meeting's quiet window: while the owner meets the lead, a message to the lead waits as an inbox line, as one to
 * any session the owner meets in its own tab does (T2985). Only a message that starts with CRITICAL goes through, for
 * what needs the owner now. The cold-send hook enforces it when the message is sent, and its reason tells the sender
 * what to do, so no session is told when the meeting starts.
 */
/** The word a message to the lead starts with to go through a meeting. */
export const CRITICAL_WORD = 'CRITICAL';
/** Whether a message is the one kind the meeting lets through: its text starts with CRITICAL, in any case. */
export function isCritical(text) {
    return new RegExp(`^\\s*${CRITICAL_WORD}\\b`, 'i').test(text);
}
/**
 * Whether the message breaks through the meeting: a CRITICAL one to the lead, from another session or an unknown one,
 * while the meeting is open. Only these lift the spotlight (T2524); the lead's own sends never do.
 */
export function isBreakthrough(facts) {
    return facts.meeting !== undefined && facts.to === facts.lead && facts.from !== facts.lead && isCritical(facts.text);
}
/** The hold's reason, or undefined to let the message go: no open meeting, another receiver, the lead's own send, an empty or CRITICAL message. */
export function quietHoldReason(facts) {
    const { meeting } = facts;
    if (meeting === undefined || facts.to !== facts.lead || facts.from === facts.lead || facts.text.trim() === '' || isCritical(facts.text)) {
        return undefined;
    }
    return (`Held: ${facts.leadName} is in the owner's daily meeting since ${facts.zone.weekdayMinute(new Date(meeting.startedAt))}. ` +
        `Keep working and leave this as one inbox line, which ${facts.leadName} reads after the meeting: ${facts.command} inbox add --to ${facts.lead} --text "...". ` +
        `Only what needs the owner now goes as a message: start it with ${CRITICAL_WORD}: and send it again.`);
}
/**
 * The hold's reason for a message to a session in its own meeting, as the daily meeting holds the lead's (T2985); or
 * undefined to let it go: no meeting in its tab, the session's own send, an empty or CRITICAL message.
 */
export function bookedHoldReason(facts) {
    const { meeting } = facts;
    if (meeting === undefined || facts.from === facts.to || facts.text.trim() === '' || isCritical(facts.text)) {
        return undefined;
    }
    const about = meeting.about.replace(/[.\s]+$/, '');
    return (`Held: ${facts.toName} is in meeting ${meeting.id} with the owner (${about}) since ${facts.zone.weekdayMinute(new Date(meeting.changedAt))}. ` +
        `Keep working and leave this as one inbox line, which ${facts.toName} reads after the meeting: ${facts.command} inbox add --to ${facts.to} --text "...". ` +
        `Only what needs the owner now goes as a message: start it with ${CRITICAL_WORD}: and send it again.`);
}
