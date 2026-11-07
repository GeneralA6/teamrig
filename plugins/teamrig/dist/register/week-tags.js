/** What an event says of a task's week; undefined when it says nothing. */
function weekOf(event) {
    switch (event.type) {
        case 'create':
            return event.task.week;
        case 'update':
            return event.changes.week;
        case 'status':
        case 'moved':
            return undefined;
    }
}
/**
 * Each task's week tags in the order they were set (T2091): a `create` carries the first, an `update` naming `week` the
 * next. `task.week` alone cannot say a task was in the plan the day it was worked, as a later retag rewrites it. Pure,
 * over one register's events.
 */
export function weekTagsOf(events) {
    const tags = new Map();
    for (const event of events) {
        const week = weekOf(event);
        if (week !== undefined) {
            const tag = { at: Date.parse(event.at), week };
            const held = tags.get(event.id);
            if (held === undefined) {
                tags.set(event.id, [tag]);
            }
            else {
                held.push(tag);
            }
        }
    }
    return tags;
}
/** The week in force at `at`: the last tag set by then; null when none was yet. */
export function weekTagAt(tags, at) {
    return tags.findLast((tag) => tag.at <= at)?.week ?? null;
}
