import type { PriorityConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { Task } from '../register/fold.ts';
import type { TaskStatus } from '../register/model.ts';
import { JsonlEventLog } from '../register/store.ts';

/** The statuses whose tasks are a session's queued work: what it can work on now. */
const QUEUED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['open', 'in-progress']);

/**
 * Each session's queued work, the weight of its part of the team's daily budget: its open and in-progress tasks,
 * each weighed by its priority, the top priority as many as the config lists and the last 1 (p1..p5: 5..1). A
 * priority the config does not list weighs 1. A session with no queued work is not in the map.
 */
export function workWeights(tasks: Iterable<Pick<Task, 'owner' | 'status' | 'priority'>>, priorities: readonly PriorityConfig[]): ReadonlyMap<string, number> {
  const ranked = priorities.map((priority) => priority.id).sort((a, b) => a - b);
  const weights = new Map<string, number>();
  for (const task of tasks) {
    if (!QUEUED.has(task.status)) {
      continue;
    }
    const rank = ranked.indexOf(task.priority);
    weights.set(task.owner, (weights.get(task.owner) ?? 0) + (rank === -1 ? 1 : ranked.length - rank));
  }
  return weights;
}

/**
 * The sessions' queued work, read from the register at `eventsPath`; empty when the register cannot be read, so
 * every part falls back to its session's `share` and a damaged register never stops the budget.
 */
export async function readWork(files: Files, eventsPath: string, priorities: readonly PriorityConfig[]): Promise<ReadonlyMap<string, number>> {
  try {
    const { state } = await new JsonlEventLog(files, eventsPath).read();
    return workWeights(state.tasks.values(), priorities);
  } catch {
    return new Map();
  }
}
