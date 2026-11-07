import { spentClassesOf } from "../budget/class-spend.js";
import { OUTSIDE_ID } from "../budget/measure.js";
import { errorMessage } from "../core/guards.js";
import { readStoredUsage, readStoredWeek } from "./stored-week.js";
const NO_CLASSES = new Set();
/**
 * The classes past their share of the week, for the WIP rule (register/wip.ts): the week and its rate as a hook reads
 * them, so a start measures no transcript, and the team's sessions alone, as `teamrig budget`'s rows count them. None
 * while the week or its rate is unknown. A read that fails holds nothing and says so: a share is a plan for the week,
 * and a broken usage store must not stop a session changing its own task.
 */
export async function readSpentClasses(runtime, paths, config, tasks, now) {
    try {
        const { window, wPerPct } = await readStoredWeek(runtime, paths, config, now);
        if (window === undefined || wPerPct === undefined) {
            return NO_CLASSES;
        }
        const usage = await readStoredUsage(runtime, paths, config.sessions);
        usage.delete(OUTSIDE_ID);
        return spentClassesOf({ states: [...usage.values()], tasks, focus: config.focus, weekFrom: window.start, wPerPct, now });
    }
    catch (error) {
        runtime.out.stderr(`WARN the week's spend by class could not be read, so no class is held for its share [focus.allocation]: ${errorMessage(error)}`);
        return NO_CLASSES;
    }
}
