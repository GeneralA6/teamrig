import { formatUtcDay } from "../core/time.js";
const DAY_MS = 86_400_000;
/** The first day whose closed issues a sync reads: `closedDays` before now, UTC. */
export function closedSince(now, closedDays) {
    return formatUtcDay(new Date(now.getTime() - closedDays * DAY_MS));
}
/** Writes the steps in order, each judged again under the register's lock; a refused step is reported and the rest still run. */
export async function applySteps(writer, steps) {
    const outcomes = [];
    for (const step of steps) {
        const verdict = await writeStep(writer, step);
        outcomes.push({ step, result: verdict.ok ? { ok: true, value: verdict.value.task.id } : verdict });
    }
    return outcomes;
}
function writeStep(writer, step) {
    switch (step.kind) {
        case 'add':
            return writer.importAdd(step.input);
        case 'update':
            return writer.importUpdate(step.id, step.changes, step.note);
        case 'status':
            return writer.importStatus(step.id, step.input);
    }
}
