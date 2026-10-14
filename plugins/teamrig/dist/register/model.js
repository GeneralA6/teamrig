import { ID_PATTERN } from "../core/ids.js";
/** Task states. The first three are active: the task still needs its owner. */
export const TASK_STATUSES = ['open', 'in-progress', 'blocked', 'done', 'dropped'];
export const ACTIVE_STATUSES = ['open', 'in-progress', 'blocked'];
export function isTaskStatus(value) {
    return TASK_STATUSES.some((status) => status === value);
}
/** Session and area names: the shared id rule, as they name inbox files and folders. */
export const SESSION_NAME = ID_PATTERN;
/** Task ids are `T` and a positive integer, allocated in order by the register. */
export const TASK_ID = /^T[1-9]\d*$/;
