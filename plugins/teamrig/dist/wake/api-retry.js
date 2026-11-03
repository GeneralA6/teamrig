import { KIT_NAME } from "../core/home.js";
import { API_RETRY_LIMIT } from "../restore/api-error.js";
import { costText } from "./decide.js";
/**
 * The prompt that sends the tab on: the error and when its turn failed on the team's clock, which retry this is, and
 * what it costs. A turn a wake had started failed before its work block began, so the prompt names the start too.
 */
export function apiRetryPrompt(session, retry, cost, zone) {
    return (`Your last turn ended on an API error (${retry.code}) at ${zone.clock(new Date(retry.failAt))}; retry ${retry.n} of ${API_RETRY_LIMIT}. ` +
        `Go on with that turn's work (if a wake started it: \`${KIT_NAME} start --session ${session}\`). ` +
        `This retry costs ${costText(cost)}.`);
}
/** The person's toast: which error the tab's turn was sent again after, which retry this is, and what it costs. */
export function apiRetryToast(retry, cost) {
    return `${KIT_NAME} retried this tab's turn that ended on an API error (${retry.code}), ${retry.n} of ${API_RETRY_LIMIT} (${costText(cost)})`;
}
