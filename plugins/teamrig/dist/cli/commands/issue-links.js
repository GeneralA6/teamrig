import { ENV, KIT_NAME } from "../../core/home.js";
import { SecretScanner } from "../../core/secrets.js";
import { changedIssues, planLinks } from "../../issues/links.js";
import { noPositionals } from "../args.js";
import { hostOf, reposOf } from "../issue-hosts.js";
import { openTeamKit, requireConfig } from "../kit.js";
import { EXIT } from "../runtime.js";
import { teamRegister } from "../team-register.js";
import { GITHUB_OFF, githubOff } from "./issue-sync-auto.js";
import { shown } from "./issue-sync.js";
/**
 * `issue links [--repo <owner/name>] [--yes]`: puts the task tree on the GitHub issues of the team's `github.repos`.
 * Each `after` edge between two tasks mirrored in one repository (issues/links.ts) makes the whole blocked by the
 * part, and a part with one whole its sub-issue. Without `--yes` it reads the links GitHub has and prints what it
 * would add, writing nothing; with it, it adds them, one call each, and stops a repository at its first failure, so
 * a rerun reads again and adds only what is still missing. Links are only added, never removed or moved: one a person
 * set on GitHub stays. The task list is only read. Exit 1 when a repository could not be read or a link not added.
 */
export async function issueLinks(args, runtime) {
    noPositionals(args);
    const write = args.switches.has('yes');
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'read');
    const say = (line) => runtime.out.stdout(line);
    if (githubOff(runtime.env)) {
        say(`OFF ${ENV.github}=${GITHUB_OFF} turns GitHub off on this machine; nothing was read or written`);
        return EXIT.ok;
    }
    if (config.github.repos.length === 0) {
        say('OFF no repository to link: list them as "owner/name" under github.repos in the team config; nothing was read or written');
        return EXIT.ok;
    }
    const tasks = (await teamRegister(runtime, kit.paths, config).snapshot()).state.tasks;
    // github.repos is GitHub's list, so every repository it names is GitHub's.
    const host = hostOf('github', runtime, new SecretScanner(config.register.secretPatterns));
    const told = new Set();
    let failed = false;
    let added = 0;
    for (const repo of reposOf(config.github.repos, args.flags.get('repo'))) {
        const reach = await host.reach(repo, write ? 'write' : 'read');
        if (reach.kind === 'unreachable') {
            say(`FAILED ${repo}: ${reach.reason}`);
            failed = true;
            continue;
        }
        if (!told.has(reach.scope)) {
            told.add(reach.scope);
            say(`ACCESS ${reach.access}`);
        }
        const read = await host.links(repo);
        if (read.kind === 'failed') {
            say(`FAILED ${repo}: ${read.reason}`);
            failed = true;
            continue;
        }
        read.notes.forEach((note) => say(`NOTE ${repo}: ${note}`));
        const plan = planLinks(tasks, repo, read.issues);
        [...planLines(repo, plan), ...shown(plan.writes.map(linkLine))].forEach(say);
        if (write) {
            const end = await addLinks(host, plan.writes);
            added += end.added;
            if (end.failure !== undefined) {
                say(`FAILED ${repo}: ${end.added} of ${plan.writes.length} link(s) added, then: ${end.failure}; a rerun adds the rest`);
                failed = true;
            }
        }
    }
    say(write ? `WROTE ${added} link(s) on GitHub; the task list was only read` : `PREVIEW nothing was written; ${KIT_NAME} issue links --yes adds the links above`);
    return failed ? EXIT.failed : EXIT.ok;
}
/** Adds each link in turn, stopping at the first failure: a refused token or a rate limit would refuse the rest too. */
async function addLinks(host, writes) {
    let added = 0;
    for (const link of writes) {
        const end = link.kind === 'sub-issue' ? await host.addSubIssue(link.parent, link.childId) : await host.addBlockedBy(link.target, link.blockerId);
        if (end.kind === 'failed') {
            return { added, failure: end.reason };
        }
        added += 1;
    }
    return { added, failure: undefined };
}
/** A repository's counts: the issues and links to add, those already there, and each kind of edge left as it is. */
function planLines(repo, plan) {
    const left = [
        ...(plan.otherParent > 0 ? [`${plan.otherParent} part(s) under another parent on GitHub get only their blocker`] : []),
        ...(plan.manyWholes > 0 ? [`${plan.manyWholes} edge(s) to a part of several wholes get only a blocker`] : []),
        ...(plan.otherRepo > 0 ? [`${plan.otherRepo} edge(s) to another repository are left for a person`] : []),
        ...(plan.missing > 0 ? [`${plan.missing} edge(s) name an issue the read did not have`] : []),
    ];
    return [
        `REPO ${repo}: ${changedIssues(plan)} issue(s) to change, ${plan.writes.length} link(s) to add, ${plan.present} already there`,
        ...(left.length === 0 ? [] : [`LEFT ${repo}: ${left.join('; ')}`]),
    ];
}
/** One link on one line, by issue numbers only. */
function linkLine(link) {
    return link.kind === 'sub-issue' ? `SUB-ISSUE #${link.child.number} under #${link.parent.number}` : `BLOCKED-BY #${link.target.number} by #${link.blocker.number}`;
}
