import { formatUtcDay } from "../core/time.js";
/** Whether the new policy frees sessions the old one could hold: off, or warn after a holding action. */
export function policyReleaseOf(before, after) {
    // Warn never held anyone, so a team that warned before frees no one either way.
    if (!before.enabled || before.overAction === 'warn') {
        return undefined;
    }
    if (!after.enabled) {
        return 'off';
    }
    return after.overAction === 'warn' ? 'warn' : undefined;
}
/**
 * The sessions of `ids` held at their last turn's end today (UTC day of `now`), in `ids` order. A warn state of an
 * earlier day says nothing of today: the new day's budget already freed it, and its next turn starts the day over.
 */
export async function heldToday(store, ids, now) {
    const day = formatUtcDay(new Date(now));
    const held = [];
    for (const id of ids) {
        const state = await store.read(id);
        if (state !== undefined && state.day === day && state.held) {
            held.push(id);
        }
    }
    return held;
}
/** The line a freed session gets: who freed it and how, and that it carries on. */
export function releaseLineOf(by, how) {
    return `Budget: ${by} ${how}, so your budget hold is over: carry on with your task list.`;
}
