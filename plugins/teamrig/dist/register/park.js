import { MS_PER_DAY } from "../core/time.js";
export function parkRulesOf(config) {
    return { focus: config.focus, ownerSource: config.register.ownerSource };
}
/**
 * Whether the task parks, the rule of design section 6 (2C): only a STORED class counts, so a task no one classed never
 * parks, and nothing parks until confirmed rows land. A waiting or verifying task stays out, as parking one would lose
 * its READY and its proof date. A row with no `updatedAt` cannot be called quiet, so it stays. `needed` comes last: it
 * can be the costliest read, and most tasks are out before it.
 */
export function wouldPark(task, input) {
    const { focus } = input;
    const stored = task.workClass ?? null;
    if (stored === null || stored === focus.roadmapClass || stored === focus.maintenanceClass || task.updatedAt === undefined) {
        return false;
    }
    const quietFor = input.now - Date.parse(task.updatedAt);
    return (task.status === 'open' &&
        quietFor >= focus.parkAfterDays * MS_PER_DAY &&
        (task.pin ?? null) === null &&
        task.critical !== true &&
        task.source !== input.ownerSource &&
        !input.needed(task.id));
}
/**
 * Whether the task waits for a leader to class it (T2076 part 2C): it holds no stored class, and no leader of its owner
 * added it, as a leader's add is the triage. Those are the owner's chain on the team and, on a child team, the parent
 * team's lead (`above`), who leads this team's lead. The lead has no leader on its team, so its add on its own task
 * counts as one. A task no one classed never parks, so a parked task never reads as untriaged.
 */
export function isUntriaged(task, leaders) {
    if (task.workClass !== null) {
        return false;
    }
    const leadOnOwnTask = task.owner === leaders.lead && task.createdBy === leaders.lead;
    return !leadOnOwnTask && task.createdBy !== leaders.above && !leaders.chainOf(task.owner).includes(task.createdBy);
}
