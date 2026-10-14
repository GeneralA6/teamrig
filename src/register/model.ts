/** Task states. The first three are active: the task still needs its owner. */
export const TASK_STATUSES = ['open', 'in-progress', 'blocked', 'done', 'dropped'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVE_STATUSES: readonly TaskStatus[] = ['open', 'in-progress', 'blocked'];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

/** Session and area names: lowercase, safe as a file name, at most 32 characters. */
export const SESSION_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Task ids are `T` and a positive integer, allocated in order by the register. */
export const TASK_ID = /^T[1-9]\d*$/;
