/** One row per item type (ITEM_TYPES), so a later type (an incident, an epic) is one more row here. */
export const ITEM_TYPE_TRAITS = {
    task: { review: false },
    bug: { review: true },
};
/** What a task is: its type, a task when no one set one. */
export function itemTypeOf(task) {
    return task.type ?? 'task';
}
/** The traits of a task's type. */
export function traitsOf(task) {
    return ITEM_TYPE_TRAITS[itemTypeOf(task)];
}
