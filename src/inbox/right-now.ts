import { isRightNow } from '../config/priorities.ts';
import type { SessionAddress } from '../core/address.ts';
import type { Task } from '../register/fold.ts';
import { isActive } from '../register/stats.ts';
import { needsOf, unansweredAsks } from '../register/tree.ts';
import { holderOf, type RegisterTasks } from './groups.ts';

const TASK_IDS = /\bT\d+\b/g;

/** A task of the tree, with the team whose register holds it. */
export interface HeldTask {
  readonly task: Task;
  readonly team: string;
}

/**
 * The first task `text` names by id (`T<n>`) that is right-now work (p0 or more urgent) and not finished, each id read
 * as team `reader` reads it (its own register first, T1139); undefined when it names none. A line about such work goes
 * out as `inbox add --wake now` (T4414): right-now work never waits for the receiver's next prompt. A finished task
 * counts for nothing, so a line saying the work is done, sent after its status, wakes no one.
 */
export function rightNowNamedIn(text: string, registers: readonly RegisterTasks[], reader: string): HeldTask | undefined {
  for (const [id] of text.matchAll(TASK_IDS)) {
    const team = holderOf(registers, reader, id);
    const task = registers.find((register) => register.team === team)?.tasks.get(id);
    if (team !== undefined && task !== undefined && isActive(task.status) && isRightNow(task.priority)) {
      return { task, team };
    }
  }
  return undefined;
}

/**
 * The sessions that act on `held` now (T4431, rule 3): its owner, the owner of each unfinished task it needs (planned
 * after or waited on, each read as its holder's register reads it), and each session asked for one of its unanswered
 * decisions or approvals, each once. A line naming the task to many sessions wakes only these; the rest read it at
 * their next prompt.
 */
export function actorsOf(held: HeldTask, registers: readonly RegisterTasks[]): SessionAddress[] {
  const { task, team } = held;
  const needs = needsOf(task).flatMap((id): SessionAddress[] => {
    const holder = holderOf(registers, team, id);
    const need = registers.find((register) => register.team === holder)?.tasks.get(id);
    return holder !== undefined && need !== undefined && isActive(need.status) ? [{ team: holder, id: need.owner }] : [];
  });
  const asked = unansweredAsks(task).map((ask) => ({ team, id: ask.who }));
  const seen = new Set<string>();
  return [{ team, id: task.owner }, ...needs, ...asked].filter((address) => {
    const key = `${address.team}/${address.id}`;
    const fresh = !seen.has(key);
    seen.add(key);
    return fresh;
  });
}
