import { ID_PATTERN } from '../core/ids.ts';

/** Task states. The first three are active: the task still needs its owner. */
export const TASK_STATUSES = ['open', 'in-progress', 'blocked', 'done', 'dropped'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVE_STATUSES: readonly TaskStatus[] = ['open', 'in-progress', 'blocked'];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

/** Session and area names: the shared id rule, as they name inbox files and folders. */
export const SESSION_NAME = ID_PATTERN;

/** A priority as the CLI prints and takes it: `p1`, the most urgent, `p2` and so on. */
export function priorityText(priority: number): string {
  return `p${priority}`;
}

/** Task ids are `T` and a positive integer, allocated in order by the register. */
export const TASK_ID = /^T[1-9]\d*$/;
