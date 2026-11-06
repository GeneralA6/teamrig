import type { PriorityConfig } from './types.ts';

/**
 * teamrig's own level above every one the config names: work that must be done right now, started ahead of the task
 * in hand. No config lists it (`register.priorities` ids start at 1), so every team has it, its own levels or not.
 */
export const NOW_PRIORITY: PriorityConfig = { id: 0, name: 'urgent, right now' };

/** Every level a task may take, most urgent first: teamrig's p0, then the config's `register.priorities`. */
export function priorityLevels(priorities: readonly PriorityConfig[]): readonly PriorityConfig[] {
  return [NOW_PRIORITY, ...priorities];
}

/** The name of priority `id`: p0's, or the one the config gives it; undefined when no level has that id. */
export function priorityName(priorities: readonly PriorityConfig[], id: number): string | undefined {
  return priorityLevels(priorities).find((priority) => priority.id === id)?.name;
}

/**
 * The most urgent level the config names: its lowest id, `p1` by default; undefined when it names none. p0 is not
 * one: the check that watches the top level (OVER-PACE) counts p0 with it, as more urgent still.
 */
export function topPriority(priorities: readonly PriorityConfig[]): number | undefined {
  return priorities.reduce<number | undefined>((top, priority) => (top === undefined || priority.id < top ? priority.id : top), undefined);
}
