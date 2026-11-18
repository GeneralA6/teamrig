import { ENV } from "../../core/home.js";
import { SecretScanner } from "../../core/secrets.js";
import { closedSince } from "../../github/sync.js";
import { targetText } from "../../issues/host.js";
import { applyPush } from "../../issues/push-apply.js";
import { changeLine, changeWrites, planPush, SESSION_PUSH, sessionLogins } from "../../issues/status-push.js";
import { RegisterPolicy } from "../../register/policy.js";
import { noPositionals } from "../args.js";
import { callerOf } from "../inputs.js";
import { hostOf, reposOf } from "../issue-hosts.js";
import { sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { GITHUB_OFF, githubOff } from "./issue-sync-auto.js";
import { openTeam } from "./register-team.js";
/** The change rows a repository prints; the rest are counted. */
export const SHOWN_CHANGES = 10;
/**
 * `issue sync --push [--repo <owner/name>] [--yes]` (T2682, T2876): the outbound half of issue sync. For each issue
 * of the team's `github.repos` a task holds, it plans the writes that make the issue show the task's status
 * (issues/status-push.ts) against the issue as the host lists it now, and prints them. Without --yes it writes
 * nothing, the dry run to read before a push; with --yes a session on the team sends each repository's plan
 * (issues/push-apply.ts), at most PUSH_WRITES_PER_RUN writes, a repository stopping at its first failure. Exit 1
 * when a repository could not be read or a write failed, else 0.
 */
export async function issuePush(args, runtime) {
    noPositionals(args);
    if (args.switches.has('auto')) {
        throw new RefusedError('--auto is the hooks\' sync, which sends the push itself when github.statusPush is on: leave out --push or --auto');
    }
    const send = args.switches.has('yes');
    const team = await openTeam(runtime, 'read');
    const config = team.config;
    if (send) {
        const notOnTeam = new RegisterPolicy(config, team.above).checkCaller(sessionIdOf(team.roster, callerOf(args.flags, runtime.env)));
        if (notOnTeam !== undefined) {
            throw new RefusedError(notOnTeam);
        }
    }
    const say = (line) => runtime.out.stdout(line);
    if (githubOff(runtime.env)) {
        say(`OFF ${ENV.github}=${GITHUB_OFF} turns GitHub off on this machine; nothing was read or written`);
        return EXIT.ok;
    }
    if (config.github.repos.length === 0) {
        say('OFF no repository to push to: list them as "owner/name" under github.repos in the team config; nothing was read or written');
        return EXIT.ok;
    }
    const totals = await pushRepos({
        // github.repos is GitHub's list, so every repository it names is GitHub's.
        host: hostOf('github', runtime, new SecretScanner(config.register.secretPatterns), config.github.stamp),
        repos: reposOf(config.github.repos, args.flags.get('repo')),
        since: closedSince(new Date(runtime.clock.now()), config.github.closedDays),
        tasks: async () => (await team.register.snapshot()).state.tasks.values(),
        send,
        limits: SESSION_PUSH,
        logins: sessionLogins(config.github.owners),
        told: new Set(),
    }, say);
    say(pushEndLine(send, totals, SESSION_PUSH.writesPerRun));
    return totals.failures.length > 0 ? EXIT.failed : EXIT.ok;
}
/**
 * Plans each repository of `run` against the register's tasks and, with send, sends the plan (issues/push-apply.ts),
 * a repository stopping at its first failed write. The run's writes are shared: each repository's plan is given what
 * the ones before it left, counted by what they planned, so a run never sends more than `limits.writesPerRun`.
 */
export async function pushRepos(run, say) {
    const failures = [];
    let left = run.limits.writesPerRun;
    let writes = 0;
    let sent = 0;
    for (const repo of run.repos) {
        const reach = await run.host.reach(repo, run.send ? 'write' : 'read');
        if (reach.kind === 'unreachable') {
            say(`FAILED ${repo}: ${reach.reason}; nothing planned for it`);
            failures.push({ repo, reason: reach.reason });
            continue;
        }
        if (!run.told.has(reach.scope)) {
            run.told.add(reach.scope);
            say(`ACCESS ${reach.access}`);
        }
        const read = await run.host.list(repo, run.since);
        if (read.kind === 'failed') {
            say(`FAILED ${repo}: ${read.reason}; nothing planned for it`);
            failures.push({ repo, reason: read.reason });
            continue;
        }
        read.notes.forEach((note) => say(`NOTE ${repo}: ${note}`));
        const plan = planPush(repo, read.issues, await run.tasks(), { writesPerRun: left, closes: run.limits.closes }, run.logins);
        planLines(plan).forEach(say);
        const planned = plan.changes.reduce((sum, change) => sum + changeWrites(change), 0);
        left -= planned;
        if (!run.send) {
            writes += planned;
            continue;
        }
        const outcome = await applyPush(run.host, plan, say);
        writes += outcome.writes;
        sent += outcome.sent;
        if (outcome.failed !== undefined) {
            failures.push({ repo, reason: outcome.failed });
        }
    }
    return { sent, writes, failures };
}
/** The line ending a push: what it sent, or, without send, that it wrote nothing and what it would send. */
export function pushEndLine(send, totals, writesPerRun) {
    return send
        ? `PUSHED ${totals.sent} change(s), ${totals.writes} write(s); at most ${writesPerRun} a run, the rest planned again on the next`
        : `PREVIEW nothing was written; a push would send ${totals.writes} write(s) now, at most ${writesPerRun} a run, and plan the rest again on the next`;
}
/** A repository's plan: its counts, the changes this run sends, then each issue the push leaves as it is and why. */
export function planLines(plan) {
    const counts = [
        `${plan.changes.length} to change`,
        `${plan.unchanged} unchanged`,
        ...(plan.deferred.length === 0 ? [] : [`${plan.deferred.length} left for the next run`]),
        ...(plan.heldCloses.length === 0 ? [] : [`${plan.heldCloses.length} close(s) held for a session's push`]),
        ...(plan.closedActive.length === 0 ? [] : [`${plan.closedActive.length} closed on the host while the task is active`]),
        ...(plan.keptOpen.length === 0 ? [] : [`${plan.keptOpen.length} left open: not the finished task's to close`]),
        ...(plan.unlisted.length === 0 ? [] : [`${plan.unlisted.length} not listed`]),
        ...(plan.shared.length === 0 ? [] : [`${plan.shared.length} held by two or more tasks`]),
    ];
    const changes = plan.changes.map(changeLine);
    const more = changes.length - SHOWN_CHANGES;
    return [
        `PUSH ${plan.repo}: ${counts.join(', ')}`,
        ...(more > 0 ? [...changes.slice(0, SHOWN_CHANGES), `... and ${more} more`] : changes),
        ...plan.heldCloses.map((held) => `${changeLine(held).replace(/^CLOSE/u, 'HELD')}; the automatic push never closes: a session's teamrig issue sync --push --yes sends the close`),
        ...plan.closedActive.map((closed) => `KEPT ${targetText(closed.target)} ${closed.task} ${closed.status}: closed on the host${closed.stateReason === '' ? '' : ` (${closed.stateReason.toLowerCase()})`} while the task is active; the push never reopens an issue, so set the task to match or reopen the issue`),
        ...plan.keptOpen.map((kept) => `OPEN ${targetText(kept.target)} ${kept.task} ${kept.status}: ${kept.why.kind === 'design' ? 'a design issue, which ends by its maintainers\' Agreed' : `taken by ${kept.why.assignees.join(', ')}, outside the team`}; the push leaves it open, for its taker or a person to close`),
        ...plan.unlisted.map((held) => `UNLISTED ${targetText(held.target)} ${held.task} ${held.status}: not open on the host (closed before github.closedDays, or gone) while the task is active; the push never reopens an issue`),
        ...plan.shared.map((shared) => `SHARED ${targetText(shared.target)} ${shared.tasks.join(', ')}: two or more team tasks hold it, so the push writes nothing; give the ref to one of them`),
    ];
}
