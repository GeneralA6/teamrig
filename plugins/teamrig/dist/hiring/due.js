import { KIT_NAME } from "../core/home.js";
import { formatUtcDay } from "../core/time.js";
import { ACTIVE_STATUSES } from "../register/model.js";
/**
 * The `check` flags on hired sessions: RETIRE-DUE when one has had no open task for `hiring.idleHours`
 * (since its hire, or since its newest task took its closed status), REVIEW-DUE when its review day has
 * passed. Pure: it takes the hires still active, the team's tasks and the clock's now.
 */
export const HIRE_FLAG_KINDS = ['RETIRE-DUE', 'REVIEW-DUE'];
const HOUR_MS = 3_600_000;
/** When the session last had an open task: its hire, or the newest status change of the tasks it owns. */
function idleSince(hire, owned) {
    return owned.reduce((latest, task) => Math.max(latest, Date.parse(task.statusAt)), hire.at);
}
function retireDue(hire, owned, input) {
    if (owned.some((task) => ACTIVE_STATUSES.includes(task.status))) {
        return undefined;
    }
    const { idleHours } = input.config.hiring;
    const hours = Math.floor((input.now.getTime() - idleSince(hire, owned)) / HOUR_MS);
    return hours < idleHours ? undefined : { kind: 'RETIRE-DUE', session: hire.session, detail: `no open task for ${hours} h, hiring.idleHours ${idleHours}` };
}
function reviewDue(hire, now) {
    return hire.reviewBy < formatUtcDay(now) ? { kind: 'REVIEW-DUE', session: hire.session, detail: `review day ${hire.reviewBy} passed` } : undefined;
}
/** The flags on each hired session still on the team, in hire order, RETIRE-DUE before REVIEW-DUE. */
export function hireFlags(input) {
    const tasks = [...input.tasks];
    return input.hires
        .filter((hire) => input.config.sessions.includes(hire.session))
        .flatMap((hire) => {
        const owned = tasks.filter((task) => task.owner === hire.session);
        return [retireDue(hire, owned, input), reviewDue(hire, input.now)].filter((flag) => flag !== undefined);
    });
}
/** One flag as `check` prints it, with the command that clears it. */
export function formatHireFlag(flag) {
    const action = flag.kind === 'RETIRE-DUE' ? 'retire it' : 'decide whether its job goes on, else retire it';
    return `HIRE ${flag.kind} (${flag.detail}) ${flag.session}: ${action} (${KIT_NAME} retire ${flag.session})`;
}
