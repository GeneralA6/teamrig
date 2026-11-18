import { lateSlices, sliceLabel } from "./goal-slices.js";
import { ACTIVE_STATUSES } from "./model.js";
/**
 * SLICE-LATE (T2203): a slice of the team's goals past its ship day, `today` on the team's clock, with no proof
 * recorded. It rides on the slice's first active task in plan order, else its first task the register holds, so it
 * reaches whoever holds the work; a slice none of whose tasks the register holds raises none, as nothing is left to
 * act on. Its owner records the proof once it shows (`goal slice <tag> <n> --proven`), or the lead moves its ship day.
 */
export function sliceLateFlags(goals, tasks, tree, today) {
    return lateSlices(goals, today).flatMap(({ goal, slice }) => {
        const held = slice.tasks.flatMap((id) => {
            const task = tasks.get(id);
            return task === undefined ? [] : [task];
        });
        const [first] = [...held.filter((task) => ACTIVE_STATUSES.includes(task.status)).sort((a, b) => tree.byPlanOrder(a, b)), ...held];
        if (first === undefined) {
            return [];
        }
        const label = sliceLabel(goal.tag, slice.number);
        const detail = `slice ${label} ${slice.title}, owner ${slice.owner}, was to ship ${slice.ship} and its proof is not recorded: once it shows, goal slice ${goal.tag} ${slice.number} --proven "<evidence>"; else the lead moves its --ship`;
        return [{ kind: 'SLICE-LATE', task: first, detail }];
    });
}
