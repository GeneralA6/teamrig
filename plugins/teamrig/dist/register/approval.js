/**
 * Who answers a wait on a task of `owner`'s: its leaders (`LeadTree.approversOf`) a decision or an approval, and the
 * team's security reviewer (`roles.securityReviewer`) an approval too, which is how the review gate holds a change
 * for it (T828), but never one on its own task. A push to a protected branch still reads only the leaders' approvals
 * (`approvedTaskOf`).
 */
export function waitAnswerersOf(tree, roles, owner) {
    const leaders = tree.approversOf(owner);
    const reviewer = roles.securityReviewer;
    const reviews = reviewer !== undefined && reviewer !== owner && !leaders.includes(reviewer);
    return { decision: leaders, approval: reviews ? [...leaders, reviewer] : leaders };
}
/**
 * The task's answer to `reason` when it is an approval wait its giver answered, either way (`approve`, T684);
 * undefined otherwise. A new status clears the answer with the waits (fold.ts), so an answer covers only the step its
 * task asked about.
 */
export function answerTo(task, reason) {
    return reason.kind === 'approval' && task.answer !== null && task.answer.by === reason.who ? task.answer : undefined;
}
/** Whether the task's answer clears `reason`: an approval wait whose giver approved it. */
export function approvalCleared(task, reason) {
    return answerTo(task, reason)?.verdict === 'approved';
}
/**
 * The first task of `owner`'s, in register order, that waits on the approval of one of `approvers` (its leaders,
 * `LeadTree.chainOf`) and has it: what lets `owner` push to a protected branch under `pushGuard.pushToProtected: lead`
 * or `gated`.
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
