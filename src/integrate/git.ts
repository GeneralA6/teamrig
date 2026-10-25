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

/** The git steps `teamrig integrate` takes, each in the folder it names; the push itself runs as a heavy step. */
export interface IntegrateGit {
  checkoutOf(dir: string): Checkout | undefined;
  /** `git status --porcelain` lines; untracked files only when `untracked`; undefined when git could not tell. */
  changes(dir: string, untracked: boolean): readonly string[] | undefined;
  /** `git fetch --prune origin`. */
  fetch(dir: string): GitOutcome;
  /** origin's default branch: `origin/HEAD`, else `main` or `master` when origin has it, else `main`. */
  defaultBranch(dir: string): string;
  /** The commit `ref` names; undefined when it names none. */
  sha(dir: string, ref: string): string | undefined;
  /** The commit `branch` is at on origin, asked of origin itself; undefined when origin has no such branch or did not answer. */
  remoteHead(dir: string, branch: string): string | undefined;
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
  /** Fast-forwards the local `branch` to `origin/<branch>` without checking it out; refused where it is checked out. */
  updateLocalBranch(dir: string, branch: string): LocalUpdate;
  checkout(dir: string, branch: string): GitOutcome;
  /** `git merge --ff-only <to>` in the checkout. */
  fastForward(dir: string, to: string): GitOutcome;
  /** `git reset --keep <to>`: moves the checked-out branch and its files back to `to`; refused where a local change would be lost. */
  resetTo(dir: string, to: string): GitOutcome;
}

/** A fetch, a push of a deleted branch or a rebase talks to origin or rewrites commits: allow it far longer than a query. */
const LONG_TIMEOUT_MS = 120_000;
const DEFAULT_BRANCHES = ['main', 'master'];
const ORIGIN_HEAD = 'refs/remotes/origin/';
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
export const GIT_INTEGRATE: IntegrateGit = {
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
  changes(dir, untracked) {
    const text = query(dir, ['status', '--porcelain', `--untracked-files=${untracked ? 'normal' : 'no'}`]);
    return text === undefined ? undefined : lines(text);
  },
  fetch: (dir) => outcome(runGit(dir, ['fetch', '--prune', 'origin'], LONG_TIMEOUT_MS), 'git fetch'),
  defaultBranch(dir) {
    const head = queryLine(dir, ['symbolic-ref', '--quiet', `${ORIGIN_HEAD}HEAD`]);
    if (head?.startsWith(ORIGIN_HEAD) === true) {
      return head.slice(ORIGIN_HEAD.length);
    }
    return DEFAULT_BRANCHES.find((name) => runGit(dir, ['show-ref', '--verify', '--quiet', `${ORIGIN_HEAD}${name}`]).status === 0) ?? 'main';
  },
  sha: (dir, ref) => queryLine(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]),
  remoteHead(dir, branch) {
    const ref = `refs/heads/${branch}`;
    const run = runGit(dir, ['ls-remote', 'origin', ref], LONG_TIMEOUT_MS);
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
  deleteRemoteBranch: (dir, branch) => outcome(runGit(dir, ['push', 'origin', '--delete', `refs/heads/${branch}`], LONG_TIMEOUT_MS), 'git push --delete'),
  detach: (dir) => outcome(runGit(dir, ['switch', '--detach']), 'git switch --detach'),
  deleteBranch: (dir, branch) => outcome(runGit(dir, ['branch', '-D', '--end-of-options', branch]), 'git branch -D'),
  updateLocalBranch(dir, branch) {
    const done = outcome(runGit(dir, ['fetch', '.', `${ORIGIN_HEAD}${branch}:refs/heads/${branch}`]), 'git fetch .');
    if (done.ok) {
      return { kind: 'updated' };
    }
    return /checked out|refusing to fetch/i.test(done.reason) ? { kind: 'checkedOut' } : { kind: 'failed', reason: done.reason };
  },
  checkout: (dir, branch) => refusedAsOption(branch, 'git checkout') ?? outcome(runGit(dir, ['checkout', branch, '--']), 'git checkout'),
  fastForward: (dir, to) => outcome(runGit(dir, ['merge', '--ff-only', '--end-of-options', to], LONG_TIMEOUT_MS), 'git merge --ff-only'),
  resetTo: (dir, to) => refusedAsOption(to, 'git reset --keep') ?? outcome(runGit(dir, ['reset', '--keep', to, '--'], LONG_TIMEOUT_MS), 'git reset --keep'),
};
