import { SecretScanner } from "../../core/secrets.js";
import { formatClocks, issueThread, parseClocks, pullThread, reminderText, stepClocks } from "../../github/clock.js";
import { issueOwner, issueRef } from "../../github/map.js";
import { postLine } from "../../inbox/inbox.js";
import { GITHUB_ACTOR } from "../../register/policy.js";
import { fileLockOf } from "../file-locks.js";
import { teamZone } from "../kit.js";
import { inboxDepsOf } from "./inbox.js";
/**
 * The response clock's part of a sync that writes (T3028, github/clock.ts): from each repository it read, the open
 * threads (issues and pull requests) and who answers each, then the clocks kept in their own file under the sync's lock, and one unwoken inbox
 * line to each owner whose thread reached 75% of its answer target. GH-LATE at 100% is `check`'s (issue-clock-check.ts).
 */
/**
 * The open issues of one repository read as threads: one a task tracks is held and answered by that task's owner, any
 * other by the import's owner rule. A post is ours by `ours`, the team's logins (github/clock.ts postIsOurs).
 */
export function repoThreads(issues, tasks, rules, ours) {
    const holders = new Map();
    for (const task of tasks) {
        if (task.ref !== null && !holders.has(task.ref)) {
            holders.set(task.ref, task.owner);
        }
    }
    return issues.flatMap((issue) => {
        const ref = issueRef(issue.repo, issue.number);
        const holder = holders.get(ref);
        return issueThread(issue, ref, holder ?? issueOwner(issue, rules), holder !== undefined, ours) ?? [];
    });
}
/**
 * The open pull requests of one repository read as `pull` threads, each once, answered by whom its news goes to: the
 * owner of the task one of our own branches names, else `watcher` (github/pull-news.ts pullRecipient). Give it the
 * open read's pull requests: only that read carries their posts (github/queries.ts).
 */
export function pullThreads(pulls, recipientOf, ours) {
    const seen = new Set();
    return pulls.flatMap((pull) => {
        const ref = issueRef(pull.repo, pull.number);
        if (seen.has(ref)) {
            return [];
        }
        seen.add(ref);
        return pullThread(pull, ref, recipientOf(pull), ours) ?? [];
    });
}
/**
 * Steps the clocks over the repositories in `read` and posts each reminder due now, unwoken. Gives one line per
 * reminder posted and per one the inbox refused.
 */
export async function recordClocks(runtime, kit, config, read, threads) {
    const now = runtime.clock.now();
    const remind = await fileLockOf(runtime, kit.paths.githubSyncLock, config.lock).run(async () => {
        const step = stepClocks(parseClocks((await runtime.files.read(kit.paths.githubClocks)) ?? ''), read, threads, now);
        await runtime.files.write(kit.paths.githubClocks, formatClocks(step.clocks));
        return step.remind;
    });
    const inboxes = inboxDepsOf(runtime, kit.paths).inboxes;
    const secrets = new SecretScanner(config.register.secretPatterns);
    const zone = teamZone(config, runtime);
    const lines = [];
    for (const clock of remind) {
        const problem = await postLine(inboxes, secrets, { to: clock.owner, from: GITHUB_ACTOR, text: reminderText(clock, now, zone), now: new Date(now) });
        lines.push(problem === undefined ? `REMINDED ${clock.owner}: ${clock.ref} waits on an answer` : `INBOX ${clock.owner}: not posted: ${problem}`);
    }
    return lines;
}
