import { ENV } from "../../core/home.js";
import { SecretScanner } from "../../core/secrets.js";
import { addedLines, claimState, failureNews, finishState, formatSyncState, isDue, parseSyncState } from "../../github/auto.js";
import { postLine } from "../../inbox/inbox.js";
import { GITHUB_ACTOR } from "../../register/policy.js";
import { inboxDepsOf } from "./inbox.js";
import { fileLockOf } from "../file-locks.js";
/**
 * The automatic GitHub sync: the Stop hook starts `gh sync --auto` hidden in the background once per
 * `github.everyMinutes` for the whole team, claimed under one lock, and that run tells each owner's inbox
 * the tasks it added and the lead's when the failing repositories change. Nothing else keeps running.
 */
/** `TEAMRIG_GITHUB=off` turns the import off on this machine, whatever the team config says. */
export const GITHUB_OFF = 'off';
export function githubOff(env) {
    return env[ENV.github]?.trim().toLowerCase() === GITHUB_OFF;
}
/** The lock around the sync state file; a hook does not wait for it, a finishing sync does. */
function stateLock(runtime, kit, config, waitMs) {
    return fileLockOf(runtime, kit.paths.githubSyncLock, { ...config.lock, waitMs });
}
async function readState(runtime, kit) {
    return parseSyncState((await runtime.files.read(kit.paths.githubSync)) ?? '');
}
/**
 * The Stop hook's part: once `github.everyMinutes` passed since the last automatic sync, claims the next one
 * and starts `gh sync --auto` hidden, for the team the hook runs for, so the hook neither prints nor waits. A
 * turn end that is not due reads one small file; the claim is checked again under the lock, which a hook
 * never waits for (another session's hook holding it is claiming the same sync). A start that fails is
 * retried at the next interval.
 */
export async function startAutoSync(runtime, kit, config) {
    const { github } = config;
    if (github.repos.length === 0 || github.everyMinutes === 0 || githubOff(runtime.env)) {
        return;
    }
    const now = runtime.clock.now();
    if (!isDue(await readState(runtime, kit), now, github.everyMinutes)) {
        return;
    }
    const claimed = await stateLock(runtime, kit, config, 0).run(async () => {
        const state = await readState(runtime, kit);
        if (!isDue(state, now, github.everyMinutes)) {
            return false;
        }
        await runtime.files.write(kit.paths.githubSync, formatSyncState(claimState(state, now)));
        return true;
    });
    if (claimed) {
        await runtime.processes.startHidden({
            command: runtime.self.node,
            args: [runtime.self.script, 'gh', 'sync', '--auto'],
            cwd: kit.paths.home,
            env: { ...runtime.env, [ENV.team]: kit.paths.team },
        });
    }
}
/**
 * What `gh sync --auto` does once it has written: records its finish and failing repositories, then posts
 * one inbox line to each owner naming the tasks added for it, and one to the lead when the failing
 * repositories changed (`failureNews`). It gives a line for each inbox line that was refused, such as an
 * issue title that matches a secret pattern.
 */
export async function reportAutoSync(runtime, kit, config, added, failures) {
    const now = runtime.clock.now();
    const before = await stateLock(runtime, kit, config, config.lock.waitMs).run(async () => {
        const state = await readState(runtime, kit);
        await runtime.files.write(kit.paths.githubSync, formatSyncState(finishState(state, now, failures)));
        return state?.failing ?? [];
    });
    const posts = [...addedLines(added)].map(([to, text]) => ({ to, text }));
    const news = failureNews(before, failures);
    if (news !== undefined) {
        posts.push({ to: config.roles.lead, text: news });
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
