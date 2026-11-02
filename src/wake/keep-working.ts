import { KIT_NAME } from '../core/home.ts';
import type { SessionAsk } from '../core/session-asks.ts';
import type { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import type { TasksElsewhere } from '../register/tree.ts';
import { waitsText } from '../register/waits.ts';
import { startableTasks } from './day-start.ts';
import { taskListText, type WakeRest } from './decide.ts';

/**
 * A session whose task goes waiting keeps working its other tasks. `set` to waiting records a keep-working ask
 * for the task's owner (a `SessionAsk` in `paths.keepWorkingAsks`); the session's next stop takes it and, while the
 * task still waits and the session owns work it can start, blocks once to send it to that work, never in the budget's
 * quiet hours or while its budget holds it or a short day pauses it (`wakeRestOf`; the day-start wake brings it back
 * to its work). Work it can start
 * is its own task it can go on with besides the waiting one (`startableTasks`), so a task not started yet that comes
 * after the waiting one, directly or through another unfinished task, stays untouched. With nothing it can start,
 * the turn ends as it would.
 */

/** The waiting task, and the session's work it can start meanwhile, most urgent first. */
export interface KeepWorking {
  readonly waiting: Task;
  readonly startable: readonly Task[];
}

export interface KeepWorkingInput {
  readonly tasks: ReadonlyMap<string, Task>;
  /** The tasks the team tree's other registers hold, which a wait or an `after` may name. */
  readonly elsewhere: TasksElsewhere;
  readonly session: string;
  readonly ask: SessionAsk;
  readonly now: number;
  /** The team's clock, for the times its waits name. */
  readonly zone: TimeZone;
  /** Where the session stands against its budget (`wakeRestOf`). */
  readonly rest: WakeRest;
}

/**
 * What the ask sends the session to; undefined in quiet hours or while its budget holds it, once the task stopped
 * waiting or changed hands, or with nothing it can start.
 */
export function keepWorkingOf(input: KeepWorkingInput): KeepWorking | undefined {
  const { tasks, elsewhere, session, ask, now, zone, rest } = input;
  const waiting = tasks.get(ask.task);
  if (rest.quiet || rest.held || waiting?.owner !== session || waiting.status !== 'waiting') {
    return undefined;
  }
  const startable = startableTasks(tasks, elsewhere, session, now, zone).filter((task) => task.id !== waiting.id);
  return startable.length === 0 ? undefined : { waiting, startable };
}

/** The Stop hook's block reason: work the tasks that do not come after the waiting one, most urgent first. */
export function keepWorkingReason(session: string, work: KeepWorking, zone: TimeZone): string {
  const { waiting, startable } = work;
  return (
    `${waiting.id} waits (${waitsText(waiting.waits, zone)}), and you own work that does not come after it: ${taskListText(startable)}. ` +
    `Work it now in priority order (\`${KIT_NAME} list --session ${session}\`); leave a task that is the same change as ${waiting.id}, and say so in one line. ` +
    'If you already work one and wait on a background step, end the turn again.'
  );
}
