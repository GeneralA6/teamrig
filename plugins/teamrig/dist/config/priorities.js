/** The name the config gives priority `id` (`register.priorities`); undefined when it names no such level. */
export function priorityName(priorities, id) {
    return priorities.find((priority) => priority.id === id)?.name;
}
/** The most urgent level the config names: its lowest id, `p1` by default; undefined when it names none. */
export function topPriority(priorities) {
    return priorities.reduce((top, priority) => (top === undefined || priority.id < top ? priority.id : top), undefined);
}
