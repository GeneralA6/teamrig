/**
 * teamrig's own level above every one the config names: work that must be done right now, started ahead of the task
 * in hand. No config lists it (`register.priorities` ids start at 1), so every team has it, its own levels or not.
 */
export const NOW_PRIORITY = { id: 0, name: 'urgent, right now' };
/**
 * True for work that must be done right now: p0, or a level teamrig puts above it. Every rule that drops what it does
 * for such work (a closed session reopened to help with it, T4414) asks this, never `=== 0`, so a level added above p0
 * passes it too.
 */
export function isRightNow(priority) {
    return priority <= NOW_PRIORITY.id;
}
/** Every level a task may take, most urgent first: teamrig's p0, then the config's `register.priorities`. */
export function priorityLevels(priorities) {
    return [NOW_PRIORITY, ...priorities];
}
/** The name of priority `id`: p0's, or the one the config gives it; undefined when no level has that id. */
export function priorityName(priorities, id) {
    return priorityLevels(priorities).find((priority) => priority.id === id)?.name;
}
/**
 * The most urgent level the config names: its lowest id, `p1` by default; undefined when it names none. p0 is not
 * one: the check that watches the top level (OVER-PACE) counts p0 with it, as more urgent still.
 */
export function topPriority(priorities) {
    return priorities.reduce((top, priority) => (top === undefined || priority.id < top ? priority.id : top), undefined);
}
