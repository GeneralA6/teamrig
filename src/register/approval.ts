import type { LeadTree } from '../config/lead-tree.ts';
import type { RolesConfig } from '../config/types.ts';
import type { ApprovalAnswer, Task } from './fold.ts';
import type { PersonWait, WaitAnswerers, WaitReason } from './waits.ts';

/**
 * Who answers a wait on a task of `owner`'s: its leaders (`LeadTree.approversOf`) a decision or an approval, and the
 * team's security reviewer (`roles.securityReviewer`) an approval too, which is how the review gate holds a change
 * for it (T828), but never one on its own task. A push to a protected branch still reads only the leaders' approvals
 * (`approvedTaskOf`).
 */
export function waitAnswerersOf(tree: Pick<LeadTree, 'approversOf'>, roles: Pick<RolesConfig, 'securityReviewer'>, owner: string): WaitAnswerers {
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
export function answerTo(task: Pick<Task, 'answer'>, reason: WaitReason): ApprovalAnswer | undefined {
  return reason.kind === 'approval' && task.answer !== null && task.answer.by === reason.who ? task.answer : undefined;
}

/** Whether the task's answer clears `reason`: an approval wait whose giver approved it. */
export function approvalCleared(task: Pick<Task, 'answer'>, reason: WaitReason): boolean {
  return answerTo(task, reason)?.verdict === 'approved';
}

/** A task of the owner's that one of its approvers approved, with who did. */
export interface ApprovedTask {
  readonly task: Task;
  readonly by: string;
}

/**
 * The first task of `owner`'s, in register order, that waits on the approval of one of `approvers` (its leaders,
 * `LeadTree.chainOf`) and has it: what lets `owner` push to a protected branch under `pushGuard.pushToProtected: lead`.
 * Undefined when it holds none.
 */
export function approvedTaskOf(tasks: Iterable<Task>, owner: string, approvers: readonly string[]): ApprovedTask | undefined {
  for (const task of tasks) {
    if (task.owner !== owner || task.status !== 'waiting') {
      continue;
    }
    const reason = task.waits.find(
      (wait): wait is PersonWait => wait.kind === 'approval' && approvers.includes(wait.who) && approvalCleared(task, wait),
    );
    if (reason !== undefined) {
      return { task, by: reason.who };
    }
  }
  return undefined;
}
