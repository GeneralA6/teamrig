import { KIT_NAME } from "../core/home.js";
import { ACTIVE_STATUSES } from "../register/model.js";
/**
 * Under `hiring.policy` `automatic`, a hired session whose last open task closes is asked at its next turn
 * end to write its handover and retire itself. `set` records the ask (a `SessionAsk` in `paths.retireAsks`); the
 * Stop hook takes it, checks the session still has no open task, and blocks once with `retireAskReason`.
 */
/** Whether `session` owns a task that is not closed. */
export function ownsOpenTask(tasks, session) {
    for (const task of tasks) {
        if (task.owner === session && ACTIVE_STATUSES.includes(task.status)) {
            return true;
        }
    }
    return false;
}
/** Whether closing the task asks its owner to retire: a hired session on the team, under `automatic`, left with no open task. */
export function retireAskDue(input) {
    const { config, task } = input;
    return (config.hiring.policy === 'automatic' &&
        config.sessions.includes(task.owner) &&
        input.hires.some((hire) => hire.session === task.owner) &&
        !ownsOpenTask(input.tasks, task.owner));
}
/** The Stop hook's block reason: write the handover, then retire, unless the job goes on. */
export function retireAskReason(id, ask, handoverPath) {
    return (`Your last open task ${ask.task} is closed and hiring.policy is automatic, so your job here may be done. ` +
        `Write your handover to ${handoverPath} (what you did, where it lives, what is left), then retire: ` +
        `\`${KIT_NAME} retire ${id} --session ${id} --yes\`. If your job goes on, or retire refuses because a task came in, say so in one line and carry on.`);
}
