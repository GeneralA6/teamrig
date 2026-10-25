import { CRITICAL_WORD, isCritical } from "../meeting/quiet.js";
/**
 * The reminder for a message, or undefined when it skips no sub-lead, is urgent or is empty (a pure idle subscription
 * carries no work). `nameOf` names a session the way the sender addresses it: its message name after a SendMessage,
 * its id after an inbox line.
 */
export function routeReminderOf(tree, message, nameOf, command) {
    const via = tree.routeVia(message.from, message.to);
    if (via === undefined || message.text.trim() === '' || isCritical(message.text)) {
        return undefined;
    }
    const subLead = nameOf(via);
    return `${command}: ${nameOf(message.to)} works under ${subLead}: route such work via ${subLead} next time; an urgent incident (a message starting ${CRITICAL_WORD}) stays direct.`;
}
