import { outcome, query, queryLine, runGit, type GitOutcome } from '../core/git-run.ts';

export type { GitOutcome };

/** Long enough for git to delete a large worktree. */
const REMOVE_TIMEOUT_MS = 120_000;
/** Long enough to fetch over a slow link, or for git to write out a large worktree. */
const ADD_TIMEOUT_MS = 120_000;

/** One worktree as `git worktree list --porcelain` lists it. */
export interface WorktreeEntry {
  /** Its folder, as git spells it (forward slashes on Windows too). */
  readonly path: string;
  /** The branch checked out there, such as `t4-parser`; undefined on a detached HEAD or a bare repository. */
  readonly branch: string | undefined;
  /** Why it is locked (empty when no reason was given); undefined when it is not locked. */
  readonly locked: string | undefined;
}

/**
 * What `teamrig worktree add` and `remove` ask of git. Each query reads as undefined when git cannot answer it (no git
 * on PATH, no repository, an unknown ref), so the caller refuses instead of guessing.
 */
export interface WorktreeGit {
  /** The top folder of the worktree that holds `dir`. */
  topOf(dir: string): string | undefined;
  /** Every worktree of the repository `dir` belongs to, the main one first. */
  worktrees(dir: string): readonly WorktreeEntry[] | undefined;
  /** The paths with uncommitted changes or untracked files in the worktree at `top`, leaving out `excluded` (paths relative to `top`). */
  changes(top: string, excluded: readonly string[]): readonly string[] | undefined;
  /** The paths git tracks at or under each of `paths` (relative to `top`), relative to `top`. */
  tracked(top: string, paths: readonly string[]): readonly string[] | undefined;
  /** The branch `origin/HEAD` names, such as `origin/main`. */
  defaultBase(dir: string): string | undefined;
  /**
   * How many commits of `branch` have no equal change on `base`: 0 when `base` holds them all, by ancestry or as
   * the same patches under new ids, as a rebase merge leaves them.
   */
  commitsNotOn(dir: string, branch: string, base: string): number | undefined;
  /** How many commits of the HEAD checked out at `top` have no equal change on `base`, counted as `commitsNotOn` counts them. */
  headCommitsNotOn(top: string, base: string): number | undefined;
  /** `git worktree remove` of the worktree at `top`, run in `mainDir`; never forced. */
  removeWorktree(mainDir: string, top: string): GitOutcome;
  /** Deletes `branch`, run in `mainDir`; the caller has checked that every commit of it is on its base. */
  deleteBranch(mainDir: string, branch: string): GitOutcome;
  /** Whether the repository `dir` belongs to has a local branch `branch`. */
  hasBranch(dir: string, branch: string): boolean | undefined;
  /** `git fetch` of `branch` from `remote`, run in `dir`, so `<remote>/<branch>` is the remote's newest. */
  fetch(dir: string, remote: string, branch: string): GitOutcome;
  /** `git worktree add` of the new branch `branch` at `path`, from `base` and with no upstream, run in `mainDir`. */
  addWorktree(mainDir: string, path: string, branch: string, base: string): GitOutcome;
}

const BRANCH_REF = 'refs/heads/';

/** NUL-separated fields, without the empty one after the last NUL. */
function fields(text: string): string[] {
  return text.split('\0').filter((field) => field !== '');
}

/** A path git reads as written: no glob, no magic of its own. */
function literal(path: string): string {
  return `:(literal)${path}`;
}

/** The output of `git worktree list --porcelain`: one block per worktree, a blank line between blocks. */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of text.replaceAll('\r\n', '\n').split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined) {
      continue;
    }
    const branchRef = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
    const lockLine = lines.find((line) => line === 'locked' || line.startsWith('locked '));
    entries.push({
      path,
      branch: branchRef?.startsWith(BRANCH_REF) === true ? branchRef.slice(BRANCH_REF.length) : undefined,
      locked: lockLine === undefined ? undefined : lockLine.slice('locked'.length).trim(),
    });
  }
  return entries;
}

/**
 * The paths of `git status --porcelain=v1 -z`: each entry is `XY path`, and a rename or copy adds its source as
 * the next field, which names the same change and is skipped.
 */
export function parseStatus(text: string): string[] {
  const paths: string[] = [];
  const parts = fields(text);
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? '';
    paths.push(entry.slice(3));
    if (/^[RC]|^.[RC]/.test(entry)) {
      index += 1;
    }
  }
  return paths;
}

/** How many commits of `ref` (a full ref name, or `HEAD`) have no equal change on `base`; undefined when git cannot tell. */
function refCommitsNotOn(dir: string, ref: string, base: string): number | undefined {
  // Both must name a commit; the caller refuses a base that starts with `-`, which git would read as an option.
  if (queryLine(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]) === undefined || queryLine(dir, ['rev-parse', '--verify', '-q', `${base}^{commit}`]) === undefined) {
    return undefined;
  }
  // Exit 0: base holds the tip; 1: it does not; anything else: git could not tell.
  const ancestor = runGit(dir, ['merge-base', '--is-ancestor', ref, base]).status;
  if (ancestor === 0) {
    return 0;
  }
  if (ancestor !== 1) {
    return undefined;
  }
  // `git cherry` marks each commit of the ref `-` when base has an equal change (same patch id), else `+`.
  const cherry = query(dir, ['cherry', base, ref]);
  return cherry === undefined ? undefined : cherry.split('\n').filter((line) => line.startsWith('+')).length;
}

/** The git CLI. */
export const GIT_WORKTREES: WorktreeGit = {
  topOf: (dir) => queryLine(dir, ['rev-parse', '--show-toplevel']),
  worktrees(dir) {
    const text = query(dir, ['worktree', 'list', '--porcelain']);
    return text === undefined ? undefined : parseWorktreeList(text);
  },
  changes(top, excluded) {
    const pathspecs = ['.', ...excluded.map((path) => `:(exclude,literal)${path}`)];
    const text = query(top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', ...pathspecs]);
    return text === undefined ? undefined : parseStatus(text);
  },
  tracked(top, paths) {
    if (paths.length === 0) {
      return [];
    }
    const text = query(top, ['ls-files', '-z', '--', ...paths.map(literal)]);
    return text === undefined ? undefined : fields(text);
  },
  defaultBase: (dir) => queryLine(dir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']),
  commitsNotOn: (dir, branch, base) => refCommitsNotOn(dir, `${BRANCH_REF}${branch}`, base),
  // Run in the worktree's own folder, `HEAD` is that worktree's, not the main checkout's.
  headCommitsNotOn: (top, base) => refCommitsNotOn(top, 'HEAD', base),
  removeWorktree: (mainDir, top) => outcome(runGit(mainDir, ['worktree', 'remove', top], REMOVE_TIMEOUT_MS), 'git worktree remove'),
  // A branch name never starts with `-` (git refuses one), so it cannot read as an option.
  deleteBranch: (mainDir, branch) => outcome(runGit(mainDir, ['branch', '-D', branch]), 'git branch -D'),
  hasBranch(dir, branch) {
    // Exit 0: the ref exists; 1: it does not; anything else: git could not tell.
    const status = runGit(dir, ['show-ref', '--verify', '--quiet', `${BRANCH_REF}${branch}`]).status;
    return status === 0 ? true : status === 1 ? false : undefined;
  },
  // The remote and branch come from origin/HEAD, never from the caller's words, so neither starts with `-`.
  fetch: (dir, remote, branch) => outcome(runGit(dir, ['fetch', '--quiet', remote, branch], ADD_TIMEOUT_MS), 'git fetch'),
  // The caller gives an absolute path and a branch name it checked starts with a letter or digit, so neither reads as an option.
  addWorktree: (mainDir, path, branch, base) => outcome(runGit(mainDir, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, path, base], ADD_TIMEOUT_MS), 'git worktree add'),
};
