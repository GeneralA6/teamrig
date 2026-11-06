import { answerTo } from './approval.ts';
import type { Task } from './fold.ts';
import { isReady, unfinishedAfter, type WaitContext } from './waits.ts';

/** The fields these readings look at; a reader's own row without `decided` or `answer` counts as undecided and unanswered. */
export type MoveFacts = Pick<Task, 'status' | 'after' | 'waits'> & Partial<Pick<Task, 'decided' | 'answer'>>;

/**
 * True when every reason the task waits for cleared, an approval its giver answered counting either way (T996): an
 * approval sends the owner to push or merge, a decline back to work on the note's point. A decided task (a leader
 * recorded the owner's answer to its card, T1366) goes on once its waits left cleared, none counting.
 */
export function waitsLetGoOn({ waits, decided = null, answer = null }: MoveFacts, context: WaitContext): boolean {
  return (waits.length > 0 || decided !== null) && waits.every((reason) => isReady(reason, context) || answerTo({ answer }, reason) !== undefined);
}

/**
 * True when nothing holds the task back: its waits let it go on and every task it comes after finished. Plan order and
 * the WIP rule both read this, so a task the list ranks as able to move is one the rule counts. A cleared or answered
 * wait holds nothing: its owner only has to set the next status, and ranking it low would hide the work most ready to
 * go on. A `waiting` task with no reason and no decision is held by what only its note says, `check`'s NO-REASON.
 */
export function canMove(task: MoveFacts, context: WaitContext): boolean {
  const nothingToWaitFor = task.waits.length === 0 && task.status !== 'waiting';
  return (nothingToWaitFor || waitsLetGoOn(task, context)) && unfinishedAfter(task.after, context).length === 0;
}
