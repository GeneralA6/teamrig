import { canMove } from "./can-move.js";
import { BLOCKER_PRIORITY_ID } from "./model.js";
/**
 * A blocker means drop everything and fix it now (T4329), so while its owner holds one it can take up, a start of any
 * other task is refused, with no mode and no `--one-commit` way past: a small fix elsewhere is still not the blocker.
 * A blocker waiting on a person (a decision or an approval) cannot move, so it holds nothing until that answer comes.
 */
/** The statuses a move into in-progress opens no new work from, as the WIP rule reads them (src/register/wip.ts). */
const NOT_A_START = ['in-progress', 'verifying', 'done'];
/** Why `task` may not move to `status` while its owner holds a blocker it can take up; undefined when nothing holds it. */
export function blockerHold(task, status, tasks, context) {
    if (status !== 'in-progress' || NOT_A_START.includes(task.status) || task.priority === BLOCKER_PRIORITY_ID) {
        return undefined;
    }
    const blockers = [...tasks].filter((held) => held.owner === task.owner && held.id !== task.id && held.priority === BLOCKER_PRIORITY_ID && (held.status === 'open' || held.status === 'in-progress') && canMove(held, context));
    const ids = blockers.map((held) => held.id).join(', ');
    return blockers.length === 0 ? undefined : `${task.owner} holds the blocker ${ids}: drop everything and fix it first; start ${task.id} once it is done or waits on an answer`;
}
