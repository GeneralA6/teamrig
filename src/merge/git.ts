import { basename, dirname, resolve } from 'node:path';
import { outcome, query, queryLine, runGit, type GitOutcome } from '../core/git-run.ts';

/** Where a checkout sits in its repository. */
export interface Checkout {
  /** Its top folder, as git spells it (forward slashes on Windows too). */
  readonly top: string;
  /** The branch checked out; undefined on a detached HEAD. */
  readonly branch: string | undefined;
  /** The main checkout, which holds the repository's `.git` folder; undefined for a bare repository or a separate git dir. */
  readonly mainCheckout: string | undefined;
  /** Whether `top` is a linked worktree rather than the main checkout. */
  readonly linked: boolean;
}

/** What updating a local branch to its remote-tracking branch did. */
export type LocalUpdate = { readonly kind: 'updated' } | { readonly kind: 'checkedOut' } | { readonly kind: 'failed'; readonly reason: string };

/** The remote a branch is pushed to, and the one a deploy pulls from. */
export const ORIGIN = 'origin';

/**
 * The git steps `teamrig merge` takes, each in the folder it names; the push itself runs as a queued step. A step
 * that names a `remote` takes a remote's name, such as {@link ORIGIN}.
 */
export interface MergeGit {
  checkoutOf(dir: string): Checkout | undefined;
  /** The repository's git common dir, absolute, which every worktree of it shares; undefined when git could not tell. */
  commonDir(dir: string): string | undefined;
  /** `git status --porcelain` lines; untracked files only when `untracked`; undefined when git could not tell. */
  changes(dir: string, untracked: boolean): readonly string[] | undefined;
  /** `git fetch --prune <remote>`. */
  fetch(dir: string, remote: string): GitOutcome;
  /** `remote`'s default branch: `<remote>/HEAD`, else `main` or `master` when the remote has it, else `main`. */
  defaultBranch(dir: string, remote: string): string;
  /** The commit `ref` names; undefined when it names none. */
  sha(dir: string, ref: string): string | undefined;
  /** The tree the commit `ref` names makes; undefined when it names no commit. */
  treeOf(dir: string, ref: string): string | undefined;
  /** The commit `branch` is at on `remote`, asked of the remote itself; undefined when it has no such branch or did not answer. */
  remoteHead(dir: string, remote: string, branch: string): string | undefined;
  mergeBase(dir: string, a: string, b: string): string | undefined;
  /** The paths changed from `base` to `head`, a rename as its two paths; undefined when git could not tell. */
  changedPaths(dir: string, base: string, head: string): readonly string[] | undefined;
  /** The text of `path` at `ref`; undefined when it has no such file. */
  fileAt(dir: string, ref: string, path: string): string | undefined;
  /** The commits in `from..to`, oldest first. */
  commits(dir: string, from: string, to: string): readonly string[];
  isAncestor(dir: string, ancestor: string, descendant: string): boolean;
  /** Rebases the checked-out branch onto `onto`; a stopped rebase is aborted, so the branch is left as it was. */
  rebase(dir: string, onto: string): GitOutcome;
  deleteRemoteBranch(dir: string, branch: string): GitOutcome;
  /** Detaches HEAD at its commit, so the branch can be deleted. */
  detach(dir: string): GitOutcome;
  deleteBranch(dir: string, branch: string): GitOutcome;
  /** Fast-forwards the local `branch` to `<remote>/<branch>` without checking it out; refused where it is checked out. */
  updateLocalBranch(dir: string, remote: string, branch: string): LocalUpdate;
  checkout(dir: string, branch: string): GitOutcome;
  /** `git merge --ff-only <to>` in the checkout. */
  fastForward(dir: string, to: string): GitOutcome;
  /** `git reset --keep <to>`: moves the checked-out branch and its files back to `to`; refused where a local change would be lost. */
  resetTo(dir: string, to: string): GitOutcome;
  /** The ssh command the user set in git's config (`core.sshCommand`, from any level); undefined when none is set. */
  sshCommand(dir: string): string | undefined;
}

/** A fetch, a push of a deleted branch or a rebase talks to a remote or rewrites commits: allow it far longer than a query. */
const LONG_TIMEOUT_MS = 120_000;
const DEFAULT_BRANCHES = ['main', 'master'];

/** Where git keeps its copies of `remote`'s branches. */
function trackingRefs(remote: string): string {
  return `refs/remotes/${remote}/`;
}
/** A full commit id: SHA-1, or SHA-256 in a repository that uses it. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function lines(text: string | undefined): readonly string[] {
  return text === undefined ? [] : text.split('\n').filter((line) => line !== '');
}

function samePlace(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/** Why a rebase stopped: its conflicting paths when it has any, else git's own reason. */
function rebaseStopped(dir: string, onto: string, said: string): string {
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
function refusedAsOption(name: string, what: string): GitOutcome | undefined {
  return name.startsWith('-') ? { ok: false, reason: `${what} refused "${name}": a branch or commit name never starts with "-"` } : undefined;
}

/** The git CLI. */
export const GIT_MERGE: MergeGit = {
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
