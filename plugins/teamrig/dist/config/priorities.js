/** The name the config gives priority `id` (`register.priorities`); undefined when it names no such level. */
export function priorityName(priorities, id) {
    return priorities.find((priority) => priority.id === id)?.name;
}
