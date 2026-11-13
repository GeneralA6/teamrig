import { KIT_NAME } from "../core/home.js";
import { targetText } from "./host.js";
import { taskIdIn } from "./posted.js";
/** The longest comment GitHub takes; another host's limit is checked by the host itself. */
export const MAX_COMMENT = 65_536;
/**
 * Why `text` may not be posted as `subject`, or undefined when it may: it is empty, too long, carries a secret
 * shape, or names a task id (a team's own number, which means nothing on the host: posted.ts).
 */
export function postRefusal(subject, text, scanner) {
    if (text.trim() === '') {
        return `${subject} is empty`;
    }
    if (text.length > MAX_COMMENT) {
        return `${subject} is ${text.length} characters, over the ${MAX_COMMENT} a comment may hold`;
    }
    const secret = scanner.refusal(subject, text);
    if (secret !== undefined) {
        return secret;
    }
    const named = taskIdIn(text);
    return named === undefined ? undefined : `${subject} names the task id ${named}: a task id is the team's own, so nothing posted shows one (name issues by #number)`;
}
/**
 * Writes `write` through `host`, one line said for each step: ACCESS (how the host is reached), then COMMENTED
 * and CLOSED, or FAILED with the host's reason. The host is reached before any write, so a key that cannot be
 * read writes nothing; a failed comment closes nothing, and a close that fails after its comment says so, so a
 * rerun does not post the comment twice. True when every step was done.
 */
export async function writeIssue(host, write, say) {
    const shown = targetText(write.target);
    const reach = await host.reach(write.target.repo);
    if (reach.kind === 'unreachable') {
        say(`FAILED ${shown}: ${reach.reason}; nothing was written`);
        return false;
    }
    say(`ACCESS ${reach.access}`);
    if (write.comment !== undefined) {
        const commented = await host.comment(write.target, write.comment);
        if (commented.kind === 'failed') {
            say(`FAILED ${shown}: ${commented.reason}${write.close ? '; it was not closed' : ''}`);
            return false;
        }
        say(`COMMENTED ${shown}`);
    }
    if (!write.close) {
        return true;
    }
    const closed = await host.close(write.target);
    if (closed.kind === 'failed') {
        const rerun = write.comment === undefined ? '' : `; the comment was posted: rerun ${KIT_NAME} issue close ${shown} without --comment`;
        say(`FAILED ${shown}: ${closed.reason}${rerun}`);
        return false;
    }
    say(`CLOSED ${shown}`);
    return true;
}
