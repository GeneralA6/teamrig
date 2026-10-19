import { KIT_NAME } from "../core/home.js";
import { formatUtcDay } from "../core/time.js";
import { ACTIVE_STATUSES } from "../register/model.js";
/**
 * The `check` flags on hired sessions: RETIRE-DUE when the burst it was hired for is over, or when it has
 * had no open task for `hiring.idleHours` (since its hire, or since its newest task took its closed status) and no
 * SCALE-OUT gives it a slice; REVIEW-DUE when its review day has passed. SCALE-OUT, on an area that needs a hire, is
 * src/hiring/scale-out.ts. Pure: it takes the hires still active, the team's tasks, the bursts over and the clock's now.
 */
export const HIRE_FLAG_KINDS = ['SCALE-OUT', 'RETIRE-DUE', 'REVIEW-DUE'];
const HOUR_MS = 3_600_000;
/** When the session last had an open task: its hire, or the newest status change of the tasks it owns. */
function idleSince(hire, owned) {
    return owned.reduce((latest, task) => Math.max(latest, Date.parse(task.statusAt)), hire.at);
}
function retireFlag(session, detail) {
    return { kind: 'RETIRE-DUE', session, detail, action: `retire it (${KIT_NAME} retire ${session})` };
}
function retireDue(hire, owned, input, busy) {
    if (hire.burst !== undefined && input.burstsOver.has(hire.burst)) {
        return retireFlag(hire.session, 'the burst it was hired for is over');
    }
    if (busy.has(hire.session) || owned.some((task) => ACTIVE_STATUSES.includes(task.status))) {
        return undefined;
    }
    const { idleHours } = input.config.hiring;
    const hours = Math.floor((input.now.getTime() - idleSince(hire, owned)) / HOUR_MS);
    return hours < idleHours ? undefined : retireFlag(hire.session, `no open task for ${hours} h, hiring.idleHours ${idleHours}`);
}
function reviewDue(hire, now) {
    if (hire.reviewBy >= formatUtcDay(now)) {
        return undefined;
    }
    const action = `decide whether its job goes on, else retire it (${KIT_NAME} retire ${hire.session})`;
    return { kind: 'REVIEW-DUE', session: hire.session, detail: `review day ${hire.reviewBy} passed`, action };
}
/**
 * The flags on each hired session still on the team, in hire order, RETIRE-DUE before REVIEW-DUE. `busy` holds the
 * idle hires a SCALE-OUT gives a slice (src/hiring/scale-out.ts), which are not due to retire for being idle.
 */
export function hireFlags(input, busy = new Set()) {
    const tasks = [...input.tasks];
    return input.hires
        .filter((hire) => input.config.sessions.includes(hire.session))
        .flatMap((hire) => {
        const owned = tasks.filter((task) => task.owner === hire.session);
        return [retireDue(hire, owned, input, busy), reviewDue(hire, input.now)].filter((flag) => flag !== undefined);
    });
}
/** One flag as `check` prints it, with what clears it. */
export function formatHireFlag(flag) {
    return `HIRE ${flag.kind} (${flag.detail}) ${flag.session}: ${flag.action}`;
}
