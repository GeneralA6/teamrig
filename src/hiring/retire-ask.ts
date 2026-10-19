import type { KitConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import type { SessionAsk } from '../core/session-asks.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES } from '../register/model.ts';
import type { HireRecord } from './log.ts';

/**
 * Under `hiring.policy` `automatic`, a hired session whose last open task closes is asked at its next turn
 * end to write its handover and retire itself. `set` records the ask (a `SessionAsk` in `paths.retireAsks`); the
 * Stop hook takes it, checks the session still has no open task, and blocks once with `retireAskReason`.
 */

/** Whether `session` owns a task that is not closed. */
export function ownsOpenTask(tasks: Iterable<Task>, session: string): boolean {
  for (const task of tasks) {
    if (task.owner === session && ACTIVE_STATUSES.includes(task.status)) {
      return true;
    }
  }
  return false;
}

export interface RetireAskInput {
  readonly config: Pick<KitConfig, 'sessions' | 'hiring'>;
  /** The hires still active (`activeHires`). */
  readonly hires: readonly HireRecord[];
  /** The task just closed (done or dropped). */
  readonly task: Task;
  /** Every task after the close. */
  readonly tasks: Iterable<Task>;
}

/** Whether closing the task asks its owner to retire: a hired session on the team, under `automatic`, left with no open task. */
export function retireAskDue(input: RetireAskInput): boolean {
  const { config, task } = input;
  return (
    config.hiring.policy === 'automatic' &&
    config.sessions.includes(task.owner) &&
    input.hires.some((hire) => hire.session === task.owner) &&
    !ownsOpenTask(input.tasks, task.owner)
  );
}

/** The Stop hook's block reason: write the handover, then retire, unless the job goes on. */
export function retireAskReason(id: string, ask: SessionAsk, handoverPath: string): string {
  return (
    `Your last open task ${ask.task} is closed and hiring.policy is automatic, so your job here may be done. ` +
    `Write your handover to ${handoverPath} (what you did, where it lives, what is left), then retire: ` +
    `\`${KIT_NAME} retire ${id} --session ${id} --yes\`. If your job goes on, or retire refuses because a task came in, say so in one line and carry on.`
  );
}
