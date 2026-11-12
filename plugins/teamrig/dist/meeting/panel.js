import { cut } from "../register/views.js";
import { oneLine } from "./agenda.js";
/** The longest summary a card shows: two lines of a 60-column pane, the full card being in the agenda the lead reads. */
export const SUMMARY_CHARS = 120;
function labelOf(team, id) {
    return team === undefined ? id : `${team}/${id}`;
}
/** A card's summary: what its card asks, else what the task is; null when it has neither, or only blanks. */
export function summaryOf(task) {
    const text = oneLine(task.card?.question ?? task.description ?? '');
    return text === '' ? null : cut(text, SUMMARY_CHARS);
}
function itemOf(team, task, decision, settled) {
    return { id: labelOf(team, task.id), title: oneLine(task.title), summary: summaryOf(task), settled, decision };
}
/** The decision a recorded note gives, its `<marker> decided:` lead-in dropped. */
export function decisionOf(note, ownerMarker) {
    if (note === null) {
        return null;
    }
    const text = oneLine(note);
    const lead = `${ownerMarker} decided:`;
    const decision = text.startsWith(lead) ? text.slice(lead.length).trim() : text;
    return decision === '' ? null : decision;
}
function settledOf(register, since, ownerMarker) {
    return register.tasks.flatMap((task) => {
        const { decided } = task;
        if (decided === null || decided.by !== register.decidedBy || Date.parse(decided.at) < since) {
            return [];
        }
        return [{ item: itemOf(register.team, task, decisionOf(decided.note, ownerMarker), true), at: Date.parse(decided.at) }];
    });
}
export function meetingPanelOf(input) {
    const since = Date.parse(input.meeting.startedAt);
    const settled = input.registers
        .flatMap((register) => settledOf(register, since, input.ownerMarker))
        .sort((a, b) => a.at - b.at)
        .map(({ item }) => item);
    const done = new Set(settled.map((item) => item.id));
    const asked = [...input.asked.daily, ...input.asked.batch]
        .map((card) => itemOf(card.team, card.task, null, false))
        .filter((item) => !done.has(item.id));
    return { startedAt: input.meeting.startedAt, items: [...settled, ...asked], current: asked[0]?.id ?? null, left: asked.length };
}
