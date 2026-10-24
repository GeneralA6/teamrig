import type { Flag } from './check.ts';
import type { Task } from './fold.ts';
import { ACTIVE_STATUSES } from './model.ts';
import { sizeText } from './views.ts';

/**
 * OVER-SIZE (T649), for `check`: each active sized task whose cost passed `multiple` times its size, the share of the
 * weekly limit it was estimated at (`--size`), so its owner re-sizes what is left or splits it off before it spends
 * more. `spentPct` gives a task's cost in percent of the weekly limit (src/cli/task-spend.ts); 0 turns the flag off.
 */
export function overSizeFlags(tasks: Iterable<Task>, spentPct: (task: string) => number, multiple: number): Flag[] {
  if (multiple <= 0) {
    return [];
  }
  const flags: Flag[] = [];
  for (const task of tasks) {
    const { size } = task;
    if (size === null || size <= 0 || !ACTIVE_STATUSES.includes(task.status)) {
      continue;
    }
    const spent = spentPct(task.id);
    if (spent > size * multiple) {
      flags.push({ kind: 'OVER-SIZE', task, detail: `spent ${sizeText(spent)} of the week, ${Number((spent / size).toFixed(1))}x its size ${sizeText(size)}` });
    }
  }
  return flags;
}
