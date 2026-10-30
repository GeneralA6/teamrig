import type { KitConfig } from '../config/types.ts';
import type { SessionAsk } from '../core/session-asks.ts';
import type { Task } from '../register/fold.ts';
import { ACTIVE_STATUSES } from '../register/model.ts';
import type { HireRecord } from './record.ts';

/**
 * Under `hiring.policy` `automatic`, a hired session whose last open task closes is asked at its next turn
 * end to write its handover, never to retire: its leader decides which workers the team needs, and the idle pass
 * deactivates a worker with no task. `set` records the ask (a `SessionAsk` in `paths.lastTaskAsks`); the Stop hook
 * takes it, checks the session still has no open task, and blocks once with `lastTaskAskReason`.
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

export interface LastTaskAskInput {
  readonly config: Pick<KitConfig, 'sessions' | 'hiring'>;
  /** The hires still active (`activeHires`). */
  readonly hires: readonly HireRecord[];
  /** The task just closed (done or dropped). */
  readonly task: Task;
  /** Every task after the close. */
  readonly tasks: Iterable<Task>;
}

/** Whether closing the task asks its owner for its handover: a hired session on the team, under `automatic`, left with no open task. */
export function lastTaskAskDue(input: LastTaskAskInput): boolean {
  const { config, task } = input;
  return (
    config.hiring.policy === 'automatic' &&
    config.sessions.includes(task.owner) &&
    input.hires.some((hire) => hire.session === task.owner) &&
    !ownsOpenTask(input.tasks, task.owner)
  );
}

/** The Stop hook's block reason: write the handover and end the turn, never retire, unless a task came in. */
export function lastTaskAskReason(ask: SessionAsk, handoverPath: string): string {
  return (
    `Your last open task ${ask.task} is closed. Write your handover to ${handoverPath} (what you did, where it lives, ` +
    'what is left), so you can start from it when work comes, then end your turn. Do not retire: your leader decides ' +
    'which workers the team needs, and a worker with no task is deactivated instead (under open.idle.mode on, the idle ' +
    'pass closes a quiet tab and reopens it when work comes). If a task came in, say so in one line and carry on.'
  );
}
