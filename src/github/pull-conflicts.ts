import { outcome, queryLine, runGit, type GitOutcome, type GitRun } from '../core/git-run.ts';
import type { IssueTarget } from '../issues/host.ts';
import { GIT_MERGE } from '../merge/git.ts';

/**
 * The files a pull request conflicts on against its base, read from a local clone (T2693): the head GitHub keeps
 * for every pull request (`refs/pull/<n>/head`, a fork's too) is fetched into a ref of teamrig's own, then
 * `git merge-tree --write-tree` merges it with the newest base in git's object store alone. The checkout, its
 * branches and its files are never touched, and nothing is written to GitHub, so a session can name what to
 * redo, or the watcher what an outside author must rebase, without a merge of its own.
 */

/** What merging a pull request's head into its base would do. */
export type MergeTreeOutcome =
  | { readonly kind: 'clean' }
  | { readonly kind: 'conflicts'; readonly files: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string };

/** The git steps the conflict check takes, each in the folder it names. */
export interface PullGit {
  /** `owner/name`, lower case, of the GitHub repository `remote`'s URL names; undefined for no such remote or another host. */
  remoteRepo(dir: string, remote: string): string | undefined;
  /** Fetches `remote`'s branches, then pull request `number`'s head into {@link pullRef}. */
  fetchPull(dir: string, remote: string, number: number): GitOutcome;
  /** `remote`'s default branch, as `teamrig merge` reads it. */
  defaultBranch(dir: string, remote: string): string;
  /** The commit `ref` names; undefined when it names none. */
  sha(dir: string, ref: string): string | undefined;
  /** Merges `head` into `base` in the object store alone. */
  mergeTree(dir: string, base: string, head: string): MergeTreeOutcome;
}

/** The remote whose pull requests are checked. */
export const PULL_REMOTE = 'origin';

/** The local ref a pull request's head is fetched into: teamrig's own namespace, so no branch or tag of the clone moves. */
export function pullRef(number: number): string {
  return `refs/teamrig/pull/${number}`;
}

/** A pull request's conflict check, as the command prints it. */
export type PullConflicts =
  | { readonly kind: 'clean'; readonly base: string; readonly baseSha: string; readonly headSha: string }
  | { readonly kind: 'conflicts'; readonly base: string; readonly baseSha: string; readonly headSha: string; readonly files: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Checks pull request `target` against `base` (default the remote's default branch) in the clone at `dir`, whose
 * {@link PULL_REMOTE} must be `target`'s repository: a clone of another repository would fetch some other pull
 * request of the same number.
 */
export function pullConflicts(git: PullGit, dir: string, target: IssueTarget, base: string | undefined): PullConflicts {
  const repo = git.remoteRepo(dir, PULL_REMOTE);
  if (repo !== target.repo) {
    const found = repo === undefined ? `has no ${PULL_REMOTE} remote on GitHub` : `is a clone of ${repo}`;
    return { kind: 'failed', reason: `run it in a clone of ${target.repo}: this folder ${found}` };
  }
  const fetched = git.fetchPull(dir, PULL_REMOTE, target.number);
  if (!fetched.ok) {
    return { kind: 'failed', reason: `fetching pull request ${target.number} failed: ${fetched.reason}` };
  }
  const branch = base ?? git.defaultBranch(dir, PULL_REMOTE);
  const baseRef = `${PULL_REMOTE}/${branch}`;
  const baseSha = git.sha(dir, baseRef);
  const headSha = git.sha(dir, pullRef(target.number));
  if (baseSha === undefined) {
    return { kind: 'failed', reason: `${PULL_REMOTE} has no branch ${branch}` };
  }
  if (headSha === undefined) {
    return { kind: 'failed', reason: `pull request ${target.number}'s head was not fetched` };
  }
  const merged = git.mergeTree(dir, baseSha, headSha);
  switch (merged.kind) {
    case 'clean':
      return { kind: 'clean', base: baseRef, baseSha, headSha };
    case 'conflicts':
      return { kind: 'conflicts', base: baseRef, baseSha, headSha, files: merged.files };
    case 'failed':
      return merged;
  }
}

/** The GitHub `owner/name` an https or ssh remote URL names, lower case; undefined for another host. */
export function githubRepoOf(url: string): string | undefined {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(url.trim());
  const repo = match?.[1];
  return repo === undefined ? undefined : repo.toLowerCase();
}

/**
 * `git merge-tree --write-tree --name-only --no-messages -z`'s answer: exit 0 merges clean; exit 1 prints the
 * merged tree's id and then each conflicting path, every field ended by NUL, so no path is quoted; any other exit
 * is a failure, such as two histories with no common commit.
 */
export function mergeTreeOutcome(run: GitRun): MergeTreeOutcome {
  if (run.status === 0) {
    return { kind: 'clean' };
  }
  if (run.status === 1) {
    const files = run.stdout.split('\0').slice(1).filter((path) => path !== '');
    return { kind: 'conflicts', files: [...new Set(files)] };
  }
  const failed = outcome(run, 'git merge-tree');
  return { kind: 'failed', reason: failed.ok ? 'git merge-tree exited 0' : failed.reason };
}

/** A fetch talks to a remote: allow it far longer than a query. */
const FETCH_TIMEOUT_MS = 120_000;

/** The git CLI. */
export const GIT_PULLS: PullGit = {
  remoteRepo(dir, remote) {
    const url = queryLine(dir, ['remote', 'get-url', '--end-of-options', remote]);
    return url === undefined ? undefined : githubRepoOf(url);
  },
  fetchPull(dir, remote, number) {
    const branches = outcome(runGit(dir, ['fetch', '--prune', '--end-of-options', remote], FETCH_TIMEOUT_MS), 'git fetch');
    if (!branches.ok) {
      return branches;
    }
    return outcome(runGit(dir, ['fetch', '--no-tags', '--end-of-options', remote, `+refs/pull/${number}/head:${pullRef(number)}`], FETCH_TIMEOUT_MS), 'git fetch');
  },
  defaultBranch: (dir, remote) => GIT_MERGE.defaultBranch(dir, remote),
  sha: (dir, ref) => GIT_MERGE.sha(dir, ref),
  mergeTree: (dir, base, head) => mergeTreeOutcome(runGit(dir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', '--end-of-options', base, head])),
};
