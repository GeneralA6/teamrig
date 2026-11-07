import { priorityText } from "./model.js";
import { planOrder } from "./tree.js";
import { sizeText, taskLabel } from "./views.js";
/**
 * Does the week's planned work fit the weekly usage limit left? A task's `size` is the % of the weekly limit it
 * takes; the week's to-do tasks are summed in plan order (tree.ts) against what is left of the pace target, and the
 * first one past that line is named with how many come after it.
 */
/**
 * The statuses whose size is still to spend. A verifying task has shipped, so what it took is already in the
 * week's use; counting its size again would spend it twice.
 */
export const FIT_STATUSES = ['open', 'in-progress', 'waiting'];
/** What is left of the pace target after the week's use, never below 0. */
export function leftOfWeek(targetPct, usedPct) {
    return Math.max(0, targetPct - usedPct);
}
/** The fit of the to-do tasks tagged with `week`, against `leftPct` (undefined: no reading, so nothing is summed). */
export function weekFit(rows, week, leftPct) {
    const toDo = rows
        .filter(({ task, tree }) => task.week === week && FIT_STATUSES.includes(task.status) && !tree.isParked(task))
        .sort((a, b) => planOrder(a.tree.placeOf(a.task), b.tree.placeOf(b.task)));
    const sized = toDo.filter(({ task }) => task.size !== null);
    const fits = new Map();
    let unfit;
    if (leftPct !== undefined) {
        let used = 0;
        for (const [index, row] of sized.entries()) {
            const size = row.task.size ?? 0;
            if (used + size > leftPct) {
                unfit = { row, roomPct: leftPct - used, after: sized.length - index - 1 };
                break;
            }
            used += size;
            fits.set(row.task.priority, (fits.get(row.task.priority) ?? 0) + size);
        }
    }
    // Plan order ranks by score, so a p2 can fit before a p1; the sums still read in priority order.
    return { leftPct, sized: sized.length, fits: new Map([...fits].sort(([a], [b]) => a - b)), unfit, unsized: toDo.length - sized.length };
}
/**
 * The fit as `plan` prints it: `fits: p1 12% · p2 8.5% (left 31%)`, then the first task that does not fit and how
 * many come after it, then how many have no size. Nothing sized prints only that last line.
 */
export function fitLines(fit) {
    const tail = fit.unsized > 0 ? [`${fit.unsized} to do without a size`] : [];
    if (fit.sized === 0) {
        return tail;
    }
    if (fit.leftPct === undefined) {
        return ['fits: unknown (no status-line reading of the week yet)', ...tail];
    }
    const shares = [...fit.fits].map(([priority, size]) => `${priorityText(priority)} ${sizeText(size)}`);
    const head = `fits: ${shares.length > 0 ? shares.join(' · ') : 'none'} (left ${sizeText(fit.leftPct)} of the week)`;
    return fit.unfit === undefined ? [head, ...tail] : [head, unfitLine(fit.unfit), ...tail];
}
function unfitLine({ row, after }) {
    const { task } = row;
    const size = task.size === null ? '' : ` ${sizeText(task.size)}`;
    return `does not fit: ${taskLabel(task, row.team)} ${priorityText(task.priority)} ${task.owner}${size} | ${task.title}${afterText(after)}`;
}
function afterText(after) {
    return after > 0 ? `, +${after} after it` : '';
}
/** OVER-LIMIT on the first task past the line, for `check`; none when everything sized fits. */
export function overLimitFlag(fit) {
    const { unfit, leftPct } = fit;
    if (unfit === undefined || leftPct === undefined) {
        return undefined;
    }
    const size = unfit.row.task.size ?? 0;
    return {
        kind: 'OVER-LIMIT',
        task: unfit.row.task,
        detail: `size ${sizeText(size)}, ${sizeText(unfit.roomPct)} of the week left after the tasks before it (left ${sizeText(leftPct)})${afterText(unfit.after)}`,
    };
}
