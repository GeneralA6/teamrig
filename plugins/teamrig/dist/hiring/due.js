import { KIT_NAME } from "../core/home.js";
import { formatUtcDay } from "../core/time.js";
/**
 * The `check` flags on hired sessions: RETIRE-DUE when the burst it was hired for is over; REVIEW-DUE when its review
 * day has passed. A hire with no task stays on the team: the idle pass (src/cli/idle-pass.ts) deactivates it, it is
 * never due to retire for being idle. SCALE-OUT, on an area that needs a hire, is src/hiring/scale-out.ts. Pure: it
 * takes the hires still active, the bursts over and the clock's now.
 */
export const HIRE_FLAG_KINDS = ['SCALE-OUT', 'RETIRE-DUE', 'REVIEW-DUE'];
function retireDue(hire, burstsOver) {
    if (hire.burst === undefined || !burstsOver.has(hire.burst)) {
        return undefined;
    }
    return { kind: 'RETIRE-DUE', session: hire.session, detail: 'the burst it was hired for is over', action: `retire it (${KIT_NAME} retire ${hire.session})` };
}
function reviewDue(hire, now) {
    if (hire.reviewBy >= formatUtcDay(now)) {
        return undefined;
    }
    const action = `keep it (${KIT_NAME} hire ${hire.session} --review <YYYY-MM-DD> --reason "<why>" --yes), else retire it (${KIT_NAME} retire ${hire.session})`;
    return { kind: 'REVIEW-DUE', session: hire.session, detail: `review day ${hire.reviewBy} passed`, action };
}
/** The flags on each hired session still on the team, in hire order, RETIRE-DUE before REVIEW-DUE. */
export function hireFlags(input) {
    return input.hires
        .filter((hire) => input.config.sessions.includes(hire.session))
        .flatMap((hire) => [retireDue(hire, input.burstsOver), reviewDue(hire, input.now)].filter((flag) => flag !== undefined));
}
/** One flag as `check` prints it, with what clears it. */
export function formatHireFlag(flag) {
    return `HIRE ${flag.kind} (${flag.detail}) ${flag.session}: ${flag.action}`;
}
