import { ACTIVE_STATUSES } from "./model.js";
import { sizeText } from "./views.js";
/**
 * OVER-SIZE (T649), for `check`: each active sized task whose cost since it was sized passed `multiple` times its size,
 * the share of the weekly limit it was estimated at (`--size`, what is left), so its owner re-sizes what is left or
 * splits it off before it spends more. `spentPct` gives a task's cost in percent of the weekly limit, counted from its
 * size base when an update sized it (src/cli/task-spend.ts), so a re-size clears the flag; 0 turns the flag off.
 */
export function overSizeFlags(tasks, spentPct, multiple) {
    if (multiple <= 0) {
        return [];
    }
    const flags = [];
    for (const task of tasks) {
        const { size } = task;
        if (size === null || size <= 0 || !ACTIVE_STATUSES.includes(task.status)) {
            continue;
        }
        const spent = spentPct(task);
        if (spent > size * multiple) {
            const since = task.sizeBase === null ? 'of the week' : 'since it was sized';
            flags.push({ kind: 'OVER-SIZE', task, detail: `spent ${sizeText(spent)} ${since}, ${Number((spent / size).toFixed(1))}x its size ${sizeText(size)}` });
        }
    }
    return flags;
}
