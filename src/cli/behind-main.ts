import { ORIGIN, type MergeGit } from '../merge/git.ts';

/** The git reads `behindMain` takes, each in the folder it names. */
export type BehindGit = Pick<MergeGit, 'checkoutOf' | 'defaultBranch' | 'sha' | 'commits'>;

/** How far a checkout is behind origin's default branch, as its last fetch left that branch. */
export interface BehindMain {
  /** The branch checked out; undefined on a detached HEAD. */
  readonly branch: string | undefined;
  /** The remote-tracking branch it lacks commits of, such as `origin/main`. */
  readonly base: string;
  readonly commits: number;
}

/**
 * How many commits of origin's default branch the checkout at `dir` lacks; undefined outside a repository, without
 * that branch, or with none to take. It reads the tracking ref and never fetches: every worktree of a repository
 * shares that ref, so any fetch there (a ship's, a merge's, a rebase's) moves it, and a start makes no network call.
 */
export function behindMain(git: BehindGit, dir: string): BehindMain | undefined {
  const checkout = git.checkoutOf(dir);
  if (checkout === undefined) {
    return undefined;
  }
  const base = `${ORIGIN}/${git.defaultBranch(dir, ORIGIN)}`;
  if (git.sha(dir, base) === undefined) {
    return undefined;
  }
  const commits = git.commits(dir, 'HEAD', base).length;
  return commits === 0 ? undefined : { branch: checkout.branch, base, commits };
}

/** The `start` line for a checkout behind main: what it lacks and what to do before editing. */
export function behindLine(behind: BehindMain): string {
  const what = behind.branch ?? 'the detached HEAD';
  return `BEHIND ${what} is ${behind.commits} commit(s) behind ${behind.base} as last fetched: rebase before you edit`;
}
