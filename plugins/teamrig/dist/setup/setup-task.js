import { KIT_NAME } from "../core/home.js";
export const SETUP_TASK_TITLE = 'Set up the team';
const SETUP_TASK_DESCRIPTION = 'Set the team up with the user (skill team-setup): ask what they want the team to do, give each session its first task and open it, then settle the budget and the local rules. Done once every session runs its first task.';
/** The setup task the lead owns, from the user, who asked for the team. */
export function setupTaskInput(lead, ownerSource) {
    return { title: SETUP_TASK_TITLE, description: SETUP_TASK_DESCRIPTION, owner: lead, source: ownerSource, priority: 1 };
}
export function setupTaskStep(snapshot, lead) {
    const tasks = [...snapshot.state.tasks.values()];
    const task = tasks.find((found) => found.title === SETUP_TASK_TITLE && found.owner === lead);
    if (task !== undefined) {
        return { kind: 'keep', task };
    }
    return tasks.length === 0 ? { kind: 'add' } : { kind: 'none' };
}
/** Adds the setup task and starts it, as the lead, when {@link setupTaskStep} says so. */
export async function applySetupTask(register, lead, ownerSource) {
    const step = setupTaskStep(await register.snapshot(), lead);
    if (step.kind !== 'add') {
        return { ok: true, value: step.kind === 'keep' ? { kind: 'kept', task: step.task } : step };
    }
    const added = await register.add(lead, setupTaskInput(lead, ownerSource));
    if (!added.ok) {
        return { ok: false, problem: added.error };
    }
    const started = await register.setStatus(lead, added.value.task.id, { status: 'in-progress' });
    return started.ok ? { ok: true, value: { kind: 'added', task: started.value.task } } : { ok: false, problem: started.error };
}
/** The line a run prints for its setup task; none when the team is past its setup. */
export function setupTaskLines(outcome, lead) {
    switch (outcome.kind) {
        case 'none':
            return [];
        case 'kept':
            return [`UNCHANGED ${outcome.task.id} ${SETUP_TASK_TITLE} (${outcome.task.status}, owner ${outcome.task.owner}): the task list already has the team's setup`];
        case 'added':
            return [
                `ADDED ${outcome.task.id} ${SETUP_TASK_TITLE}, in progress, owner ${lead}: close it with ${KIT_NAME} set ${outcome.task.id} --status done once every session runs its first task`,
            ];
    }
}
/** The line a dry run prints: what a run would do about the setup task. */
export function setupTaskDryLines(step, lead) {
    switch (step.kind) {
        case 'none':
            return [];
        case 'keep':
            return setupTaskLines({ kind: 'kept', task: step.task }, lead);
        case 'add':
            return [`WOULD ADD ${SETUP_TASK_TITLE}, in progress, owner ${lead}`];
    }
}
