import type { PriorityConfig } from './types.ts';

/** The name the config gives priority `id` (`register.priorities`); undefined when it names no such level. */
export function priorityName(priorities: readonly PriorityConfig[], id: number): string | undefined {
  return priorities.find((priority) => priority.id === id)?.name;
}
