import { ENV, KIT_NAME } from "../../core/home.js";
import { SecretScanner } from "../../core/secrets.js";
import { closedSince } from "../../github/sync.js";
import { targetText } from "../../issues/host.js";
import { changeLine, changeWrites, PUSH_WRITES_PER_RUN, planPush } from "../../issues/status-push.js";
import { noPositionals } from "../args.js";
import { hostOf, reposOf } from "../issue-hosts.js";
import { openTeamKit, requireConfig } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { teamRegister } from "../team-register.js";
import { GITHUB_OFF, githubOff } from "./issue-sync-auto.js";
/** The change rows a repository prints; the rest are counted. */
export const SHOWN_CHANGES = 10;
/**
 * `issue sync --push [--repo <owner/name>]` (T2682): the outbound half of issue sync. For each issue of the team's
 * `github.repos` a task holds, it plans the writes that make the issue show the task's status (issues/status-push.ts)
 * against the issue as the host lists it now, and prints them. This version only plans: it reads the issues and the
 * task list and writes nothing, the dry run the writes are checked against before they ship. Exit 1 when a
 * repository could not be read, else 0.
 */
export async function issuePush(args, runtime) {
    noPositionals(args);
    if (args.switches.has('auto')) {
        throw new RefusedError('--auto imports issues; the push is planned by hand: leave out --auto');
    }
    if (args.switches.has('yes')) {
        throw new RefusedError(`--push only plans in this version and writes nothing on the issues: run ${KIT_NAME} issue sync --push without --yes`);
    }
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const say = (line) => runtime.out.stdout(line);
    if (githubOff(runtime.env)) {
        say(`OFF ${ENV.github}=${GITHUB_OFF} turns GitHub off on this machine; nothing was read or written`);
        return EXIT.ok;
    }
    if (config.github.repos.length === 0) {
        say('OFF no repository to push to: list them as "owner/name" under github.repos in the team config; nothing was read or written');
        return EXIT.ok;
    }
    const register = teamRegister(runtime, kit.paths, config);
    const since = closedSince(new Date(runtime.clock.now()), config.github.closedDays);
    // github.repos is GitHub's list, so every repository it names is GitHub's.
    const host = hostOf('github', runtime, new SecretScanner(config.register.secretPatterns));
    const told = new Set();
    let failed = false;
    let writes = 0;
    for (const repo of reposOf(config.github.repos, args.flags.get('repo'))) {
        const reach = await host.reach(repo, 'read');
        if (reach.kind === 'unreachable') {
            say(`FAILED ${repo}: ${reach.reason}; nothing planned for it`);
            failed = true;
            continue;
        }
        if (!told.has(reach.scope)) {
            told.add(reach.scope);
            say(`ACCESS ${reach.access}`);
        }
        const read = await host.list(repo, since);
        if (read.kind === 'failed') {
            say(`FAILED ${repo}: ${read.reason}; nothing planned for it`);
            failed = true;
            continue;
        }
        read.notes.forEach((note) => say(`NOTE ${repo}: ${note}`));
        const plan = planPush(repo, read.issues, (await register.snapshot()).state.tasks.values());
        planLines(plan).forEach(say);
        writes += plan.changes.reduce((sum, change) => sum + changeWrites(change), 0);
    }
    say(`PREVIEW nothing was written; a push would send ${writes} write(s) now, at most ${PUSH_WRITES_PER_RUN} a run, and plan the rest again on the next`);
    return failed ? EXIT.failed : EXIT.ok;
}
/** A repository's plan: its counts, the changes this run sends, then each issue the push leaves as it is and why. */
export function planLines(plan) {
    const counts = [
        `${plan.changes.length} to change`,
        `${plan.unchanged} unchanged`,
        ...(plan.deferred.length === 0 ? [] : [`${plan.deferred.length} left for the next run`]),
        ...(plan.closedActive.length === 0 ? [] : [`${plan.closedActive.length} closed on the host while the task is active`]),
        ...(plan.unlisted.length === 0 ? [] : [`${plan.unlisted.length} not listed`]),
    ];
    const changes = plan.changes.map(changeLine);
    const more = changes.length - SHOWN_CHANGES;
    return [
        `PUSH ${plan.repo}: ${counts.join(', ')}`,
        ...(more > 0 ? [...changes.slice(0, SHOWN_CHANGES), `... and ${more} more`] : changes),
        ...plan.closedActive.map((closed) => `KEPT ${targetText(closed.target)} ${closed.task} ${closed.status}: closed on the host${closed.stateReason === '' ? '' : ` (${closed.stateReason.toLowerCase()})`} while the task is active; the push never reopens an issue, so set the task to match or reopen the issue`),
        ...plan.unlisted.map((held) => `UNLISTED ${targetText(held.target)} ${held.task} ${held.status}: not open on the host (closed before github.closedDays, or gone) while the task is active; the push never reopens an issue`),
    ];
}
