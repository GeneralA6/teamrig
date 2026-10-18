import { rangeText } from "../coordinator/ledger.js";
import { rangeInstallTouches } from "../integrate/dependencies.js";
/** The repositories with a roll block, in config order, each with its main checkout as a place. */
export function rollRepos(coordinator, inTeam) {
    return Object.entries(coordinator.repos).flatMap(([name, config]) => (config.roll === undefined ? [] : [{ name, config, roll: config.roll, main: inTeam(config.mainCheckout) }]));
}
export function short(sha) {
    return sha.slice(0, 8);
}
export function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}
/** Why a dependency gate holds the range: its package files need an install; undefined when they do not. */
async function dependencyHold(git, repo, head, target) {
    const touches = await rangeInstallTouches(git, repo.main, head, target);
    if (touches === undefined) {
        return `could not read what ${short(head)}..${short(target)} changes, so the dependency gate cannot clear it`;
    }
    if (touches.length === 0) {
        return undefined;
    }
    return `deps changed (${touches.join(', ')}): coordinator.repos.${repo.name}.dependencyGate holds a dependency change, since pulling it changes, unreviewed, the node_modules every worktree links to; pull and install by hand`;
}
/** Fetches and reads what a roll would pull now, refusing a main checkout it must not pull into. */
export async function readPending(git, repo) {
    const { main, name } = repo;
    const checkout = git.checkoutOf(main);
    if (checkout === undefined) {
        return { kind: 'refused', reason: `${main} (coordinator.repos.${name}.mainCheckout) is not a git checkout` };
    }
    const fetched = git.fetch(main);
    if (!fetched.ok) {
        return { kind: 'failed', reason: `git fetch failed in ${main}: ${fetched.reason}` };
    }
    const defaultBranch = git.defaultBranch(main);
    if (checkout.branch !== defaultBranch) {
        return { kind: 'refused', reason: `the ${name} main checkout ${main} is on ${checkout.branch ?? 'a detached HEAD'}, not ${defaultBranch}` };
    }
    const changes = git.changes(main, false);
    if (changes === undefined) {
        return { kind: 'failed', reason: `git status failed in ${main}` };
    }
    if (changes.length > 0) {
        return { kind: 'refused', reason: `the ${name} main checkout ${main} has ${plural(changes.length, 'uncommitted change')}: a roll pulls only into a clean checkout` };
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
        return { kind: 'refused', reason: `the ${name} main checkout ${main} has commits that are not on origin/${defaultBranch}: a roll only pulls fast-forward` };
    }
    const held = repo.config.dependencyGate ? await dependencyHold(git, repo, head, target) : undefined;
    if (held !== undefined) {
        return { kind: 'refused', reason: held };
    }
    const commits = git.commits(main, head, target);
    return { kind: 'pending', pending: { head, target, commits, range: rangeText(commits, target) } };
}
