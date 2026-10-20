/**
 * Whether the task's answer clears `reason`: an approval wait whose giver approved it (`approve`, T684). A new status
 * clears the answer with the waits (fold.ts), so an approval covers only the step its task asked about.
 */
export function approvalCleared(task, reason) {
    return reason.kind === 'approval' && task.answer?.verdict === 'approved' && task.answer.by === reason.who;
}
/**
 * The first task of `owner`'s, in register order, that waits on `lead`'s approval and has it: what lets `owner` push to
 * a protected branch under `pushGuard.pushToProtected: lead`. Undefined when it holds none.
 */
export function leadApprovedTask(tasks, owner, lead) {
    for (const task of tasks) {
        if (task.owner === owner && task.status === 'waiting' && task.waits.some((reason) => reason.kind === 'approval' && reason.who === lead && approvalCleared(task, reason))) {
            return task;
        }
    }
    return undefined;
}
