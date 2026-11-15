import { cardLabel, decisionKey } from "./decision-order.js";
import { isOwnerAnswer } from "./notices.js";
/** The keys (decisionKey) of the cards the lead recorded an owner's answer on since `since`, over every register read. */
export function answeredKeys(reads, since) {
    const keys = new Set();
    for (const { events, decidedBy, team } of reads) {
        for (const event of events) {
            if (event.type === 'update' && event.by === decidedBy && Date.parse(event.at) >= since && isOwnerAnswer(event)) {
                keys.add(cardLabel(team, event.id));
            }
        }
    }
    return keys;
}
/** The keys of the cards asked, in the agenda's order, that got no answer: those the meeting carries over. */
export function carriedKeys(asked, answered) {
    return asked.map(decisionKey).filter((key) => !answered.has(key));
}
