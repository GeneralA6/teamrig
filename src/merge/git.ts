import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { outcome, query, queryBytes, queryLine, runGit, type GitOutcome } from '../core/git-run.ts';
import { printable } from '../core/printable.ts';

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

/**
 * A read's answer, or which read git did not answer and why (T3368): a git that did not start, was stopped or died
 * starting is never taken for git's "no".
 */
export type GitRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** What the ship tool check reads of the checkout holding a file (T3223). */
export interface FileCheckout {
  /** Its top folder, as git spells it. */
  readonly top: string;
  /** Its repository's git common dir, absolute. */
  readonly commonDir: string;
  /** Whether it has no change at all, untracked files counted. */
  readonly clean: boolean;
  /** Whether the file is a tracked file of HEAD's commit. */
  readonly tracked: boolean;
  /** HEAD's commit and the tree it makes; undefined on an unborn branch. */
  readonly head: string | undefined;
  readonly headTree: string | undefined;
  /** The default branch as of the last fetch, such as `origin/main`, and its tree; undefined when it names no commit. */
  readonly mainRef: string;
  readonly mainTree: string | undefined;
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
  /** The checkout holding `file` (T3223), undefined when it is in none, or which read git did not answer (T3368). */
  fileCheckout(file: string): GitRead<FileCheckout | undefined>;
  /** The git common dir of the repository `dir` is in, undefined when it is in none, or which read git did not answer. */
  repositoryOf(dir: string): GitRead<string | undefined>;
  /** The version `git version` names, such as `2.30.2`, run in `dir`; undefined when git could not tell (#1472). */
  gitVersion(dir: string): string | undefined;
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
  /**
   * The text of each of `paths` that is a file at the commit `ref`, by path, read in one git run however many are
   * asked (T4035); a path with no file there, a folder too, is not in the map. Undefined when git could not tell, such
   * as when `ref` names no commit.
   */
  filesAt(dir: string, ref: string, paths: readonly string[]): ReadonlyMap<string, string> | undefined;
  /**
   * The blob id of each of `paths` at the commit `ref`, by path; a path `ref` has no file at is not in the map.
   * Undefined when git could not tell, such as when `ref` names no commit (or one git collected).
   */
  blobsAt(dir: string, ref: string, paths: readonly string[]): ReadonlyMap<string, string> | undefined;
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
  /** `git switch --detach <ref>`: moves a checkout on no branch, and its files, to `ref`; refused where a local change would be lost. */
  detachAt(dir: string, ref: string): GitOutcome;
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

/** Aborts the rebase that stopped in `dir` and says why it stopped (see {@link rebaseStopReason}). */
function rebaseStopped(dir: string, onto: string, said: string): string {
  const conflicts = (query(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=U', '-z']) ?? '').split('\0').filter((path) => path !== '');
  const abort = outcome(runGit(dir, ['rebase', '--abort'], LONG_TIMEOUT_MS), 'git rebase --abort');
  return rebaseStopReason(onto, conflicts, said, abort);
}

/**
 * Why a rebase stopped: its conflicting paths when it has any, else git's own reason. A conflict also says the way
 * out: a force-push of a branch already pushed for review would throw away what its reviewers saw, so the resolved
 * change goes out again under a new branch name. The paths print with control characters escaped: `-z` leaves them
 * raw, and a newline or ESC in one would add lines to the reason or reach the terminal.
 */
export function rebaseStopReason(onto: string, conflicts: readonly string[], said: string, abort: GitOutcome): string {
  const why = conflicts.length > 0 ? `conflicts in ${conflicts.map(printable).join(', ')}` : said;
  const aborted = abort.ok || /no rebase in progress/i.test(abort.reason);
  const left = aborted ? 'aborted, the branch is as it was' : `git rebase --abort failed too (${abort.reason}): finish or abort it by hand`;
  const fix = aborted && conflicts.length > 0 ? `; to land it, rebase onto ${onto} by hand, resolve those files and merge again, a branch already pushed for review under a new name, never force-pushed` : '';
  return `rebase onto ${onto} stopped (${why}); ${left}${fix}`;
}

/**
 * A refusal when `name` starts with '-', which git would read as an option; undefined otherwise. `checkout` and `reset`
 * cannot end their options with `--end-of-options` as the other steps do (git 2.39 reads it there as a pathspec or
 * refuses it), so they take the name before a `--` and need this check: no branch or commit name starts with '-'.
 */
function refusedAsOption(name: string, what: string): GitOutcome | undefined {
  return name.startsWith('-') ? { ok: false, reason: `${what} refused "${name}": a branch or commit name never starts with "-"` } : undefined;
}

/** The branch a remote's default is taken to be when it names none of its own. */
export const FALLBACK_BRANCH = 'main';

/** A git run that answered: its exit code and stdout. */
interface Answer {
  readonly status: number | null;
  readonly stdout: string;
}

/** `remote`'s default branch, read through `run`: `<remote>/HEAD`, else `main` or `master` when the remote has it, else {@link FALLBACK_BRANCH}. */
function defaultBranchBy(run: (args: readonly string[]) => Answer, remote: string): string {
  const refs = trackingRefs(remote);
  const said = run(['symbolic-ref', '--quiet', `${refs}HEAD`]);
  const head = said.status === 0 ? said.stdout.trim() : '';
  if (head.startsWith(refs)) {
    return head.slice(refs.length);
  }
  return DEFAULT_BRANCHES.find((name) => run(['show-ref', '--verify', '--quiet', `${refs}${name}`]).status === 0) ?? FALLBACK_BRANCH;
}

/** A read git did not answer, naming it and why; {@link readOrUnanswered} turns it into its {@link GitRead}. */
class Unanswered extends Error {}

/** git's answer to a read in `dir`; throws {@link Unanswered} when git gave none. */
function answer(dir: string, args: readonly string[]): Answer {
  const run = runGit(dir, args);
  if (run.unanswered !== undefined) {
    throw new Unanswered(`git ${args.join(' ')} in ${dir} did not answer: ${run.unanswered}`);
  }
  return run;
}

/** A read made of several git reads, or the first one git did not answer. */
function readOrUnanswered<T>(read: () => T): GitRead<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof Unanswered) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}

/** `file`'s path inside the checkout at `top`, with forward slashes; undefined when it is the top itself or outside it. */
export function pathInCheckout(top: string, file: string): string | undefined {
  const path = relative(top, file).replaceAll('\\', '/');
  return path === '' || path.startsWith('../') || isAbsolute(path) ? undefined : path;
}

/** The most output one `cat-file --batch` read may print: room for a large tool's whole code. */
const BATCH_MAX_BYTES = 256 * 1024 * 1024;

/** A found object's line in `git cat-file --batch` output: `<id> <type> <size>`. */
const BATCH_FOUND = /^[0-9a-f]{40,64} ([a-z]+) (\d+)$/;

/** An object `git cat-file --batch` found: its type (`blob`, `tree`, `commit`) and its content as text. */
export interface BatchObject {
  readonly type: string;
  readonly text: string;
}

/**
 * What `git cat-file --batch` printed for `count` names, in the order asked (T4035): each answer is a found object's
 * `<id> <type> <size>` line, its `size` bytes and a line break, or one line naming what it could not find, read as
 * undefined. Undefined when the output does not hold exactly `count` whole answers.
 */
export function catFileBatchOf(output: Buffer, count: number): readonly (BatchObject | undefined)[] | undefined {
  const answers: (BatchObject | undefined)[] = [];
  let at = 0;
  while (answers.length < count) {
    const end = output.indexOf(0x0a, at);
    if (end < 0) {
      return undefined;
    }
    const found = BATCH_FOUND.exec(output.toString('utf8', at, end));
    at = end + 1;
    const type = found?.[1];
    if (found === null || type === undefined) {
      answers.push(undefined);
      continue;
    }
    const size = Number(found[2]);
    if (at + size >= output.length || output[at + size] !== 0x0a) {
      return undefined;
    }
    answers.push({ type, text: output.toString('utf8', at, at + size) });
    at += size + 1;
  }
  return at === output.length ? answers : undefined;
}

/** A one-line answer, or undefined when git said no or nothing. */
function lineOf(run: Answer): string | undefined {
  const line = run.stdout.trim();
  return run.status === 0 && line !== '' ? line : undefined;
}

/** {@link MergeGit.fileCheckout} by the git CLI; throws {@link Unanswered}. */
function fileCheckoutOf(file: string): FileCheckout | undefined {
  const where = answer(dirname(file), ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  const [top, commonDir] = where.status === 0 ? lines(where.stdout) : [];
  if (top === undefined || commonDir === undefined) {
    return undefined;
  }
  const status = answer(top, ['status', '--porcelain', '--untracked-files=normal']);
  const path = pathInCheckout(top, file);
  // Literal pathspecs, so a `*` or `[` in the file's name matches only that file; a folder lists its files, not itself.
  const listed = path === undefined ? undefined : answer(top, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', '--full-tree', '--end-of-options', 'HEAD', '--', path]);
  const mainRef = `${ORIGIN}/${defaultBranchBy((args) => answer(top, args), ORIGIN)}`;
  return {
    top,
    commonDir,
    clean: status.status === 0 && lines(status.stdout).length === 0,
    tracked: listed?.status === 0 && listed.stdout.split('\0').includes(path ?? ''),
    head: lineOf(answer(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'])),
    headTree: lineOf(answer(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}^{tree}'])),
    mainRef,
    mainTree: lineOf(answer(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${mainRef}^{commit}^{tree}`])),
  };
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
  defaultBranch: (dir, remote) => defaultBranchBy((args) => runGit(dir, args), remote),
  fileCheckout: (file) => readOrUnanswered(() => fileCheckoutOf(file)),
  repositoryOf: (dir) =>
    readOrUnanswered(() => {
      const run = answer(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const line = run.stdout.trim();
      return run.status === 0 && line !== '' ? line : undefined;
    }),
  gitVersion: (dir) => /^git version (\d+(?:\.\d+)*)/.exec(queryLine(dir, ['version']) ?? '')?.[1],
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
  filesAt(dir, ref, paths) {
    // `cat-file --batch` reads one name a line, so a ref or path holding a line break cannot be asked.
    if ([ref, ...paths].some((name) => name.includes('\n'))) {
      return undefined;
    }
    // The commit is asked first in the same run, so a ref that names none tells nothing, and git starts once.
    const names = [`${ref}^{commit}`, ...paths.map((path) => `${ref}:${path}`)];
    const output = queryBytes(dir, ['cat-file', '--batch'], names.map((name) => `${name}\n`).join(''), BATCH_MAX_BYTES);
    const answers = output === undefined ? undefined : catFileBatchOf(output, names.length);
    if (answers?.[0]?.type !== 'commit') {
      return undefined;
    }
    const files = new Map<string, string>();
    paths.forEach((path, at) => {
      const found = answers[at + 1];
      if (found?.type === 'blob') {
        files.set(path, found.text);
      }
    });
    return files;
  },
  blobsAt(dir, ref, paths) {
    const wanted = new Set(paths);
    if (wanted.size === 0) {
      return new Map();
    }
    // Literal pathspecs, so a `*` or `[` in a file's name matches only that file. A path that is a folder at `ref`
    // lists its files instead, which are not asked for: such a path has no file there.
    const text = query(dir, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', '--end-of-options', ref, '--', ...wanted]);
    if (text === undefined) {
      return undefined;
    }
    const blobs = new Map<string, string>();
    for (const entry of text.split('\0')) {
      // `<mode> <type> <id>\t<path>`
      const tab = entry.indexOf('\t');
      const id = entry.slice(0, tab).split(' ')[2];
      const path = entry.slice(tab + 1);
      if (tab > 0 && id !== undefined && wanted.has(path)) {
        blobs.set(path, id);
      }
    }
    return blobs;
  },
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
  detachAt: (dir, ref) => refusedAsOption(ref, 'git switch --detach') ?? outcome(runGit(dir, ['switch', '--detach', ref], LONG_TIMEOUT_MS), 'git switch --detach'),
  sshCommand: (dir) => queryLine(dir, ['config', '--get', 'core.sshCommand']),
};
