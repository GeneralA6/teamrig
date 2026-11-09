import { DIST, DIST_SUBJECT } from './ship-commits.ts';
import type { Chunk } from './ship-plan.ts';

/**
 * A ship run again on a branch its earlier run already committed to starts from the plan once more (T1017,
 * T1216). That happens after a failed build or local gate, and on every approval-gated ship: a first run without
 * --merge for the review, then the same plan with --merge. The rerun found its chunks committed already (nothing
 * left to commit) and its version raise committed (sync.ts refuses that), so the skill told the session to undo
 * them by hand with `git reset --soft`, which auto mode refuses as a history rewrite for every team.
 *
 * So the ship takes back its own commits itself: the newest commits of the branch, only while they are the plan's
 * first chunks in order (by subject, any version named in it aside, and only files the chunk lists), optionally
 * followed by the dist commit. A soft reset keeps every change in the working tree, including a fix made after
 * the failure, so nothing is lost. Commits already pushed are refused instead: a pushed branch is never rewritten
 * (the lead's ruling of 11-06), it is reshipped under a new name.
 */

export interface RerunDeps {
  /** Runs git in the repo dir and returns its trimmed stdout; throws when git fails. */
  readonly git: (...args: string[]) => string;
  readonly log: (line: string) => void;
}

/** One commit of the branch and the paths it changed. */
export interface BranchCommit {
  readonly sha: string;
  readonly subject: string;
  readonly files: readonly string[];
}

/** sync.ts may set the raise again on a newer main, so a committed subject can name another version than the plan. */
const withoutVersions = (subject: string): string => subject.replace(/\d+\.\d+\.\d+/g, '<version>');

const madeFor = (commit: BranchCommit, chunk: Chunk): boolean =>
  withoutVersions(commit.subject) === withoutVersions(chunk.subject) && commit.files.length > 0 && commit.files.every((path) => chunk.files.includes(path));

const isDist = (commit: BranchCommit): boolean =>
  commit.subject === DIST_SUBJECT && commit.files.length > 0 && commit.files.every((path) => path.startsWith(`${DIST}/`));

/** Whether `tail` is the plan's first `tail.length` chunks in order, the last one the dist commit when `dist` is set. */
function isEarlierRun(tail: readonly BranchCommit[], chunks: readonly Chunk[], dist: boolean): boolean {
  const made = dist ? tail.slice(0, -1) : tail;
  const last = tail.at(-1);
  if (dist && (last === undefined || !isDist(last))) return false;
  return made.length > 0 && made.length <= chunks.length && made.every((commit, index) => {
    const chunk = chunks[index];
    return chunk !== undefined && madeFor(commit, chunk);
  });
}

/**
 * How many of the branch's newest commits (`commits`, oldest first) an earlier run of `chunks` made; 0 when the
 * branch does not end that way. A dist commit may follow any number of chunks: a plan can grow between runs.
 */
export function earlierRunCommits(commits: readonly BranchCommit[], chunks: readonly Chunk[]): number {
  for (let count = Math.min(commits.length, chunks.length + 1); count > 0; count--) {
    const tail = commits.slice(commits.length - count);
    if (isEarlierRun(tail, chunks, true) || isEarlierRun(tail, chunks, false)) return count;
  }
  return 0;
}

const lines = (text: string, separator: string): string[] => text.split(separator).filter((line) => line !== '');

/** The branch's commits since it left `base`, oldest first. */
function branchCommits(git: RerunDeps['git'], base: string): BranchCommit[] {
  const from = git('merge-base', 'HEAD', base);
  return lines(git('rev-list', '--reverse', `${from}..HEAD`), '\n').map((sha) => ({
    sha,
    subject: git('log', '-1', '--format=%s', sha),
    files: lines(git('diff-tree', '-z', '--no-commit-id', '--name-only', '-r', sha), '\0'),
  }));
}

/** Whether origin's `branch` holds the commit `sha`. */
function isPushed(git: RerunDeps['git'], branch: string, sha: string): boolean {
  const [tip = ''] = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split('\t');
  if (tip === '') return false;
  try {
    return git('merge-base', sha, tip) === sha;
  } catch {
    // origin's tip is a commit this clone lacks, so it may hold the commit: treat it as pushed.
    return true;
  }
}

/** Takes back the commits an earlier run of `chunks` made on the checked-out branch; returns how many. */
export function takeBackEarlierRun(deps: RerunDeps, chunks: readonly Chunk[], base: string): number {
  const { git } = deps;
  const commits = branchCommits(git, base);
  const count = earlierRunCommits(commits, chunks);
  const taken = commits.slice(commits.length - count);
  const [first] = taken;
  if (first === undefined) return 0;
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (isPushed(git, branch, first.sha)) {
    throw new Error(
      `REFUSED ${count} commit(s) an earlier run of this plan made are on origin/${branch}, and a pushed branch is never rewritten: ` +
        `ship the change under a new branch name (git branch -m ${branch} ${branch}-b), then ship again`,
    );
  }
  git('reset', '--quiet', '--soft', `${first.sha}~1`);
  git('restore', '--staged', '--', ...new Set(taken.flatMap((commit) => (isDist(commit) ? [DIST] : commit.files))));
  deps.log(`took back ${count} commit(s) an earlier run of this plan made (${taken.map((commit) => commit.sha.slice(0, 7)).join(', ')}): the plan commits them again`);
  return count;
}
