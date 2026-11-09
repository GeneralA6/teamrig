import { basename, dirname, resolve } from 'node:path';
import { outcome, query, queryLine, runGit } from "../core/git-run.js";
/** The remote a branch is pushed to, and the one a deploy pulls from. */
export const ORIGIN = 'origin';
/** A fetch, a push of a deleted branch or a rebase talks to a remote or rewrites commits: allow it far longer than a query. */
const LONG_TIMEOUT_MS = 120_000;
const DEFAULT_BRANCHES = ['main', 'master'];
/** Where git keeps its copies of `remote`'s branches. */
function trackingRefs(remote) {
    return `refs/remotes/${remote}/`;
}
/** A full commit id: SHA-1, or SHA-256 in a repository that uses it. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function lines(text) {
    return text === undefined ? [] : text.split('\n').filter((line) => line !== '');
}
function samePlace(a, b) {
    return resolve(a) === resolve(b);
}
/** Why a rebase stopped: its conflicting paths when it has any, else git's own reason. */
function rebaseStopped(dir, onto, said) {
    const conflicts = (query(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U', '-z']) ?? '').split('\0').filter((path) => path !== '');
    const why = conflicts.length > 0 ? `conflicts in ${conflicts.join(', ')}` : said;
    const abort = outcome(runGit(dir, ['rebase', '--abort'], LONG_TIMEOUT_MS), 'git rebase --abort');
    const left = abort.ok || /no rebase in progress/i.test(abort.reason) ? 'aborted, the branch is as it was' : `git rebase --abort failed too (${abort.reason}): finish or abort it by hand`;
    return `rebase onto ${onto} stopped (${why}); ${left}`;
}
/**
 * A refusal when `name` starts with '-', which git would read as an option; undefined otherwise. `checkout` and `reset`
 * cannot end their options with `--end-of-options` as the other steps do (git 2.39 reads it there as a pathspec or
 * refuses it), so they take the name before a `--` and need this check: no branch or commit name starts with '-'.
 */
function refusedAsOption(name, what) {
    return name.startsWith('-') ? { ok: false, reason: `${what} refused "${name}": a branch or commit name never starts with "-"` } : undefined;
}
/** The git CLI. */
export const GIT_MERGE = {
    checkoutOf(dir) {
        const [top, gitDir, commonDir] = lines(query(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']));
        if (top === undefined || gitDir === undefined || commonDir === undefined) {
            return undefined;
        }
        return {
            top,
            branch: queryLine(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
            mainCheckout: basename(commonDir) === '.git' ? dirname(commonDir) : undefined,
            linked: !samePlace(gitDir, commonDir),
        };
    },
    commonDir: (dir) => queryLine(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    changes(dir, untracked) {
        const text = query(dir, ['status', '--porcelain', `--untracked-files=${untracked ? 'normal' : 'no'}`]);
        return text === undefined ? undefined : lines(text);
    },
    fetch: (dir, remote) => outcome(runGit(dir, ['fetch', '--prune', '--end-of-options', remote], LONG_TIMEOUT_MS), 'git fetch'),
    defaultBranch(dir, remote) {
        const refs = trackingRefs(remote);
        const head = queryLine(dir, ['symbolic-ref', '--quiet', `${refs}HEAD`]);
        if (head?.startsWith(refs) === true) {
            return head.slice(refs.length);
        }
        return DEFAULT_BRANCHES.find((name) => runGit(dir, ['show-ref', '--verify', '--quiet', `${refs}${name}`]).status === 0) ?? 'main';
    },
    sha: (dir, ref) => queryLine(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]),
    treeOf: (dir, ref) => queryLine(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}^{tree}`]),
    remoteHead(dir, remote, branch) {
        const ref = `refs/heads/${branch}`;
        const run = runGit(dir, ['ls-remote', '--end-of-options', remote, ref], LONG_TIMEOUT_MS);
        const found = run.status === 0 ? lines(run.stdout).map((line) => line.split('\t')).find(([, name]) => name === ref) : undefined;
        const sha = found?.[0];
        return sha !== undefined && FULL_SHA.test(sha) ? sha : undefined;
    },
    mergeBase: (dir, a, b) => queryLine(dir, ['merge-base', '--end-of-options', a, b]),
    changedPaths(dir, base, head) {
        const text = query(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', '--end-of-options', base, head, '--']);
        return text === undefined ? undefined : text.split('\0').filter((path) => path !== '');
    },
    fileAt: (dir, ref, path) => query(dir, ['cat-file', 'blob', `${ref}:${path}`]),
    commits: (dir, from, to) => lines(query(dir, ['rev-list', '--reverse', '--end-of-options', `${from}..${to}`])),
    isAncestor: (dir, ancestor, descendant) => runGit(dir, ['merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant]).status === 0,
    rebase(dir, onto) {
        const run = runGit(dir, ['rebase', '--end-of-options', onto], LONG_TIMEOUT_MS);
        const done = outcome(run, 'git rebase');
        return done.ok ? done : { ok: false, reason: rebaseStopped(dir, onto, done.reason) };
    },
    deleteRemoteBranch: (dir, branch) => outcome(runGit(dir, ['push', ORIGIN, '--delete', `refs/heads/${branch}`], LONG_TIMEOUT_MS), 'git push --delete'),
    detach: (dir) => outcome(runGit(dir, ['switch', '--detach']), 'git switch --detach'),
    deleteBranch: (dir, branch) => outcome(runGit(dir, ['branch', '-D', '--end-of-options', branch]), 'git branch -D'),
    updateLocalBranch(dir, remote, branch) {
        const done = outcome(runGit(dir, ['fetch', '.', `${trackingRefs(remote)}${branch}:refs/heads/${branch}`]), 'git fetch .');
        if (done.ok) {
            return { kind: 'updated' };
        }
        return /checked out|refusing to fetch/i.test(done.reason) ? { kind: 'checkedOut' } : { kind: 'failed', reason: done.reason };
    },
    checkout: (dir, branch) => refusedAsOption(branch, 'git checkout') ?? outcome(runGit(dir, ['checkout', branch, '--']), 'git checkout'),
    fastForward: (dir, to) => outcome(runGit(dir, ['merge', '--ff-only', '--end-of-options', to], LONG_TIMEOUT_MS), 'git merge --ff-only'),
    resetTo: (dir, to) => refusedAsOption(to, 'git reset --keep') ?? outcome(runGit(dir, ['reset', '--keep', to, '--'], LONG_TIMEOUT_MS), 'git reset --keep'),
    sshCommand: (dir) => queryLine(dir, ['config', '--get', 'core.sshCommand']),
};
