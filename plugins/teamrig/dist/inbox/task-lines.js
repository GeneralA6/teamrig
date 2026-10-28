import { TASK_ID } from "../register/model.js";
import { lineOnClock, postedAt } from "./inbox.js";
/** The task id as a whole word of the team's own ids: `T5` in `T5,` or `task:T5`, never in `T50` or `web/T5`. */
function naming(id) {
    return new RegExp(`(?<![\\w/])${id}(?!\\d)`);
}
/**
 * Every line of the team's inboxes that names task `id`, in the order posted (T1196). A scope correction sent by line
 * then reaches the task's `show`, not only the handover of the session that read it, which a rewrite can drop
 * (T1189). Nothing for a string that is no task id.
 */
export async function taskLinesOf(inboxes, id) {
    if (!TASK_ID.test(id)) {
        return [];
    }
    const names = naming(id);
    const receivers = new Map();
    for (const area of await inboxes.areas()) {
        for (const line of (await inboxes.lines(area)) ?? []) {
            if (names.test(line)) {
                receivers.set(line, [...(receivers.get(line) ?? []), area]);
            }
        }
    }
    const at = (line) => postedAt(line)?.getTime() ?? 0;
    return [...receivers].map(([line, to]) => ({ line, to })).sort((a, b) => at(a.line) - at(b.line));
}
/** `inbox lines naming T5 (2):`, then each line on the team's clock with who got it; nothing when no line names it. */
export function formatTaskLines(id, lines, zone) {
    if (lines.length === 0) {
        return [];
    }
    return [`inbox lines naming ${id} (${lines.length}):`, ...lines.map(({ line, to }) => `  ${lineOnClock(line, zone)} (to ${to.join(', ')})`)];
}
