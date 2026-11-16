import { ENV } from "../../core/home.js";
import { writableObject } from "../../core/jsonl.js";
import { SecretScanner } from "../../core/secrets.js";
import { addedLines, failureNews, finishState, formatSyncState, leftOutNews, parseSyncState, SYNC_STATE_FORMAT, } from "../../github/auto.js";
import { postLine } from "../../inbox/inbox.js";
import { GITHUB_ACTOR } from "../../register/policy.js";
import { inboxDepsOf } from "./inbox.js";
import { fileLockOf } from "../file-locks.js";
/**
 * The automatic GitHub sync's report: `issue watch` (issue-watch.ts) runs `issue sync --auto` when GitHub changed,
 * and that run tells each owner's inbox the tasks it added, and the lead's when the failing repositories change or an
 * outsider's issue is newly left out.
 */
/** `TEAMRIG_GITHUB=off` turns the import off on this machine, whatever the team config says. */
export const GITHUB_OFF = 'off';
export function githubOff(env) {
    return env[ENV.github]?.trim().toLowerCase() === GITHUB_OFF;
}
/** The lock around the sync state file, held while a finishing sync records its end. */
function stateLock(runtime, kit, config, waitMs) {
    return fileLockOf(runtime, kit.paths.githubSyncLock, { ...config.lock, waitMs });
}
/**
 * The state before a write, under the lock. A file a newer teamrig wrote is refused (`NewerDataError`), so an older
 * teamrig still running in some tab never drops its fields: its hook starts no sync, its `issue sync --auto` fails.
 */
async function writableState(runtime, kit) {
    const text = await runtime.files.read(kit.paths.githubSync);
    writableObject(kit.paths.githubSync, text, SYNC_STATE_FORMAT);
    return parseSyncState(text ?? '');
}
/**
 * What `issue sync --auto` does once it has written: records its finish, failing repositories and left-out issues,
 * then posts one inbox line to each owner naming the tasks added for it, one to the lead when the failing
 * repositories changed (`failureNews`) and one when an outsider's issue was left out that was not before
 * (`leftOutNews`). It gives a line for each inbox line that was refused, such as an issue title that matches a
 * secret pattern.
 */
export async function reportAutoSync(runtime, kit, config, run) {
    const now = runtime.clock.now();
    const { before, after } = await stateLock(runtime, kit, config, config.lock.waitMs).run(async () => {
        const state = await writableState(runtime, kit);
        const finished = finishState(state, now, run.failures, run.leftOut);
        await runtime.files.write(kit.paths.githubSync, formatSyncState(finished));
        return { before: state, after: finished };
    });
    const posts = [...addedLines(run.added)].map(([to, text]) => ({ to, text }));
    const news = [failureNews(before?.failing ?? [], run.failures), leftOutNews(before?.leftOut ?? new Map(), after.leftOut, config.github.acceptLabel)];
    for (const text of news) {
        if (text !== undefined) {
            posts.push({ to: config.roles.lead, text });
        }
    }
    const inboxes = inboxDepsOf(runtime, kit.paths).inboxes;
    const secrets = new SecretScanner(config.register.secretPatterns);
    const refused = [];
    for (const { to, text } of posts) {
        const problem = await postLine(inboxes, secrets, { to, from: GITHUB_ACTOR, text, now: new Date(now) });
        if (problem !== undefined) {
            refused.push(`INBOX ${to}: not posted: ${problem}`);
        }
    }
    return refused;
}
