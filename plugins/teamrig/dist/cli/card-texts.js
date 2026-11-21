import { describedTask } from "../register/description-cut.js";
import { waitsOnOwner } from "../register/owner-waits.js";
/**
 * The working set with the description of each cut task `shown` selects, as the history holds it. `history` is read
 * once, and only when such a task exists; the tasks keep their order.
 */
export async function withDescriptions(snapshot, history, shown) {
    const cut = [...snapshot.state.tasks.values()].filter((task) => task.descriptionCut !== null && shown(task));
    if (cut.length === 0) {
        return snapshot;
    }
    const whole = (await history()).state.tasks;
    const tasks = new Map(snapshot.state.tasks);
    for (const task of cut) {
        tasks.set(task.id, describedTask(task, whole.get(task.id)));
    }
    return { ...snapshot, state: { ...snapshot.state, tasks } };
}
/** The register as read: for a command that prints no card's description. */
export const asRead = (read) => Promise.resolve(read);
/**
 * The register with the description of every task that waits on its team's owner (waitsOnOwner): each card the
 * meeting's agenda, `decisions` and `meet --cards` print is one of those.
 */
export const withCardTexts = async (read) => {
    const owner = read.config.register.ownerSource;
    return { ...read, snapshot: await withDescriptions(read.snapshot, read.history, (task) => waitsOnOwner(task, owner)) };
};
