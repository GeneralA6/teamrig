import { ID_PATTERN } from "../core/ids.js";
/**
 * Task states. The first four are active: the task still needs its owner. `verifying` is a change that has
 * shipped and waits for what proves it (a test run, a night's flow, a number), named in its status note.
 */
export const TASK_STATUSES = ['open', 'in-progress', 'verifying', 'blocked', 'done', 'dropped'];
export const ACTIVE_STATUSES = ['open', 'in-progress', 'verifying', 'blocked'];
export function isTaskStatus(value) {
    return TASK_STATUSES.some((status) => status === value);
}
/** Session and area names: the shared id rule, as they name inbox files and folders. */
export const SESSION_NAME = ID_PATTERN;
/** A priority as the CLI prints and takes it: `p1`, the most urgent, `p2` and so on. */
export function priorityText(priority) {
    return `p${priority}`;
}
/** Task ids are `T` and a positive integer, allocated in order by the register. */
export const TASK_ID = /^T[1-9]\d*$/;
