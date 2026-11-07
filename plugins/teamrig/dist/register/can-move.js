import { answerTo } from "./approval.js";
import { isReady, unfinishedAfter } from "./waits.js";
/**
 * True when every reason the task waits for cleared, an approval its giver answered counting either way (T996): an
 * approval sends the owner to push or merge, a decline back to work on the note's point. A decided task (a leader
 * recorded the owner's answer to its card, T1366) goes on once its waits left cleared, none counting.
 */
export function waitsLetGoOn({ waits, decided = null, answer = null }, context) {
    return (waits.length > 0 || decided !== null) && waits.every((reason) => isReady(reason, context) || answerTo({ answer }, reason) !== undefined);
}
/**
 * True when nothing holds the task back: its waits let it go on and every task it comes after finished. Plan order and
 * the WIP rule both read this, so a task the list ranks as able to move is one the rule counts. A cleared or answered
 * wait holds nothing: its owner only has to set the next status, and ranking it low would hide the work most ready to
 * go on. A `waiting` task with no reason and no decision is held by what only its note says, `check`'s NO-REASON.
 */
export function canMove(task, context) {
    const nothingToWaitFor = task.waits.length === 0 && task.status !== 'waiting';
    return (nothingToWaitFor || waitsLetGoOn(task, context)) && unfinishedAfter(task.after, context).length === 0;
}
