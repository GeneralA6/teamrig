/**
 * A task id such as T12, alone or after a team (`bravo/T12`). Task ids number one team's own list, so they mean
 * nothing on an issue host and look out of place there: nothing teamrig posts shows one, and an issue and its task
 * are matched by the task's ref instead, which is never posted.
 */
const TASK_ID = /\bT\d+\b/u;
/** The first task id `text` names, or undefined when it names none. */
export function taskIdIn(text) {
    return TASK_ID.exec(text)?.[0];
}
