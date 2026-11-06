import type { FocusConfig } from '../config/types.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import { answerTo } from './approval.ts';
import { classOf } from './focus.ts';
import type { Task } from './fold.ts';
import type { PersonWait } from './waits.ts';

/** What the leader-wait rule reads of the focus config. */
export type LeaderWaitFocus = Pick<FocusConfig, 'roadmapClass' | 'defaultClass' | 'leaderWaitMinutes'>;

/** The whole minutes `task` has held its waits at `at`. */
export function waitedMinutes(task: Pick<Task, 'waitsAt'>, at: number): number {
  return Math.floor((at - Date.parse(task.waitsAt)) / MS_PER_MINUTE);
}

/**
 * The waits that hold `task` on a leader past the limit (T2076): a Roadmap task's decision or approval asked of one of
 * `leaders` and not answered, once its waits have stood strictly past `focus.leaderWaitMinutes`, so a limit of 0 holds
 * from the first moment after the ask. An answer either way ends the hold, as the next step is then the owner's. The
 * clock is `waitsAt`, never `statusAt`: a task parked for days on other work that only now asks its leader gets the
 * leader the whole limit. `leaders` are the owner's (`LeadTree.approversOf`), so the security reviewer, who may answer
 * an approval but leads no one, and the human owner are never in them.
 */
export function leaderHolds(task: Pick<Task, 'workClass' | 'waits' | 'waitsAt' | 'answer'>, leaders: readonly string[], focus: LeaderWaitFocus, at: number): PersonWait[] {
  if (classOf(task, focus) !== focus.roadmapClass || at - Date.parse(task.waitsAt) <= focus.leaderWaitMinutes * MS_PER_MINUTE) {
    return [];
  }
  return task.waits.filter((reason): reason is PersonWait => (reason.kind === 'decision' || reason.kind === 'approval') && leaders.includes(reason.who) && answerTo(task, reason) === undefined);
}
