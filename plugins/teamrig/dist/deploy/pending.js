import { rangeText } from "../delivery/ledger.js";
import { rangeInstallTouches } from "../merge/dependencies.js";
import { ORIGIN } from "../merge/git.js";
/** The repositories with a deploy block, in config order, each with its main checkout as a place. */
export function deployRepos(delivery, inTeam) {
    return Object.entries(delivery.repos).flatMap(([name, config]) => (config.deploy === undefined ? [] : [{ name, config, deploy: config.deploy, main: inTeam(config.mainCheckout) }]));
}
export function short(sha) {
    return sha.slice(0, 8);
}
export function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}
/**
 * What the range's package files need after the pull: nothing, an install (checked first when `dependencyGate` is on)
 * or a hold. The gate holds a dependency change unless `dependencyCheck` and `deploy.dependencyInstall` are both set;
 * with the gate off, an install set runs unchecked, and with neither the range deploys as it is.
 */
async function dependencyStep(git, repo, head, target) {
    const { name, main, config, deploy } = repo;
    const install = deploy.dependencyInstall;
    if (!config.dependencyGate && install === undefined) {
        return { kind: 'step', step: undefined };
    }
    const touches = await rangeInstallTouches(git, main, head, target);
    if (touches === undefined) {
        return { kind: 'held', reason: `could not read what ${short(head)}..${short(target)} changes, so the deploy cannot tell whether it changes the dependencies` };
    }
    if (touches.length === 0) {
        return { kind: 'step', step: undefined };
    }
    const check = config.dependencyGate ? config.dependencyCheck : undefined;
    if (install !== undefined && (check !== undefined || !config.dependencyGate)) {
        return { kind: 'step', step: { touches, check, install } };
    }
    const unset = [...(check === undefined ? ['dependencyCheck'] : []), ...(install === undefined ? ['deploy.dependencyInstall'] : [])].map((key) => `delivery.repos.${name}.${key}`);
    return {
        kind: 'held',
        reason: `deps changed (${touches.join(', ')}): delivery.repos.${name}.dependencyGate holds a dependency change, since pulling it changes, unreviewed, the node_modules every worktree links to; set ${unset.join(' and ')} to deploy one, or pull and install by hand`,
    };
}
/** Fetches and reads what a deploy would pull now, refusing a main checkout it must not pull into. */
export async function readPending(git, repo) {
    const { main, name } = repo;
    const checkout = git.checkoutOf(main);
    if (checkout === undefined) {
        return { kind: 'refused', reason: `${main} (delivery.repos.${name}.mainCheckout) is not a git checkout` };
    }
    const fetched = git.fetch(main, ORIGIN);
    if (!fetched.ok) {
        return { kind: 'failed', reason: `git fetch failed in ${main}: ${fetched.reason}` };
    }
    const defaultBranch = git.defaultBranch(main, ORIGIN);
    if (checkout.branch !== defaultBranch) {
        return { kind: 'refused', reason: `the ${name} main checkout ${main} is on ${checkout.branch ?? 'a detached HEAD'}, not ${defaultBranch}` };
    }
    const changes = git.changes(main, false);
    if (changes === undefined) {
        return { kind: 'failed', reason: `git status failed in ${main}` };
    }
    if (changes.length > 0) {
        return { kind: 'refused', reason: `the ${name} main checkout ${main} has ${plural(changes.length, 'uncommitted change')}: a deploy pulls only into a clean checkout` };
    }
    const head = git.sha(main, 'HEAD');
    const target = git.sha(main, `origin/${defaultBranch}`);
    if (head === undefined || target === undefined) {
        return { kind: 'failed', reason: head === undefined ? `HEAD names no commit in ${main}` : `origin/${defaultBranch} is missing in ${main} after the fetch` };
    }
    if (head === target) {
        return { kind: 'none', head };
    }
    if (!git.isAncestor(main, head, target)) {
        return { kind: 'refused', reason: `the ${name} main checkout ${main} has commits that are not on origin/${defaultBranch}: a deploy only pulls fast-forward` };
    }
    const deps = await dependencyStep(git, repo, head, target);
    if (deps.kind === 'held') {
        return { kind: 'refused', reason: deps.reason };
    }
    const commits = git.commits(main, head, target);
    return { kind: 'pending', pending: { head, target, commits, range: rangeText(commits, target), deps: deps.step } };
}
