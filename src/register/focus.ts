import type { FocusConfig } from '../config/types.ts';
import type { TaskFields } from './events.ts';

/**
 * The work class a task counts as (T2076): its own `workClass`, else the team's `focus.defaultClass`, so a task no one
 * classed ranks with team tooling, last. Pure, so the CLI and the pane read a class the same way.
 */
export function classOf(task: Pick<TaskFields, 'workClass'>, focus: Pick<FocusConfig, 'defaultClass'>): string {
  return task.workClass ?? focus.defaultClass;
}
