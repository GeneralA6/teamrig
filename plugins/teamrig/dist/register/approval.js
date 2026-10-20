/**
 * Whether the task's answer clears `reason`: an approval wait whose giver approved it (`approve`, T684). A new status
 * clears the answer with the waits (fold.ts), so an approval covers only the step its task asked about.
 */
export function approvalCleared(task, reason) {
    return reason.kind === 'approval' && task.answer?.verdict === 'approved' && task.answer.by === reason.who;
}
/**
 * The first task of `owner`'s, in register order, that waits on the approval of one of `approvers` (its leaders,
 * `LeadTree.chainOf`) and has it: what lets `owner` push to a protected branch under `pushGuard.pushToProtected: lead`.
 * Undefined when it holds none.
 */
export function approvedTaskOf(tasks, owner, approvers) {
    for (const task of tasks) {
        if (task.owner !== owner || task.status !== 'waiting') {
            continue;
        }
        const reason = task.waits.find((wait) => wait.kind === 'approval' && approvers.includes(wait.who) && approvalCleared(task, wait));
        if (reason !== undefined) {
            return { task, by: reason.who };
        }
    }
    return undefined;
}
