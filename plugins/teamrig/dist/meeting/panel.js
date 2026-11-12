import { oneLine } from "./agenda.js";
function labelOf(team, id) {
    return team === undefined ? id : `${team}/${id}`;
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
        const item = { id: labelOf(register.team, task.id), title: oneLine(task.title), settled: true, decision: decisionOf(decided.note, ownerMarker) };
        return [{ item, at: Date.parse(decided.at) }];
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
        .map((card) => ({ id: labelOf(card.team, card.task.id), title: oneLine(card.task.title), settled: false, decision: null }))
        .filter((item) => !done.has(item.id));
    return { startedAt: input.meeting.startedAt, items: [...settled, ...asked], current: asked[0]?.id ?? null, left: asked.length };
}
