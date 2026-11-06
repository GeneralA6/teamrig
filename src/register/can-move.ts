import { answerTo } from './approval.ts';
import type { Task } from './fold.ts';
import { isReady, unfinishedAfter, type WaitContext, type WaitReason } from './waits.ts';

/**
 * True when every reason the task waits for cleared, an approval its giver answered counting either way (T996): an
 * approval sends the owner to push or merge, a decline back to work on the note's point. A decided task (a leader
 * recorded the owner's answer to its card, T1366) goes on once its waits left cleared, none counting.
 */
export function waitsLetGoOn(task: Task, context: WaitContext): boolean {
  return (task.waits.length > 0 || task.decided !== null) && task.waits.every((reason) => isReady(reason, context) || answerTo(task, reason) !== undefined);
}

/**
 * True when nothing holds the task back: every wait cleared and every task it comes after finished. Plan order and the
 * WIP rule both read this, so a task the list ranks as able to move is one the rule counts. A cleared wait holds
 * nothing: its owner only has to set the next status, and ranking it low would hide the work most ready to go on.
 */
export function canMove(task: { readonly after: readonly string[]; readonly waits: readonly WaitReason[] }, context: WaitContext): boolean {
  return task.waits.every((reason) => isReady(reason, context)) && unfinishedAfter(task.after, context).length === 0;
}
