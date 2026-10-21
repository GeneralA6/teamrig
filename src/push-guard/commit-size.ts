import type { CommitsConfig } from '../config/types.ts';

/** One file a commit changed: the lines added and deleted, or null for a binary file. */
export interface FileChange {
  readonly path: string;
  readonly added: number | null;
  readonly deleted: number | null;
}

export interface CommitStat {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
  readonly files: readonly FileChange[];
}

/** What the commit-size rule reads from a repository; the hook asks git, tests pass a fake. */
export interface CommitLog {
  /** The commits reachable from `tip` and not from `base`, newest first; undefined when git cannot tell (an unknown ref, no repository). */
  between(dir: string, base: string, tip: string): readonly CommitStat[] | undefined;
}

/** What a commit weighs against the rule: the changed lines and files that are not tests. */
export interface CommitWeight {
  readonly lines: number;
  readonly files: number;
}

export interface LargeCommit extends CommitWeight {
  readonly sha: string;
  readonly subject: string;
}

/** The part of the team's `commits` config the size rule reads. */
export type CommitSizeRule = Pick<CommitsConfig, 'maxLines' | 'maxFiles' | 'largeCommitTrailer' | 'testPatterns'>;

/** The `git log` format `parseCommitLog` reads: a record separator, then sha, subject and body split by unit separators. */
export const COMMIT_LOG_FORMAT = '%x1e%H%x1f%s%x1f%b%x1f';

/** At most this many large commits are named in one message; the rest are counted. */
const NAMED_MAX = 5;
const SUBJECT_MAX = 60;

/** The path a numstat rename ends at: `src/{a => b}/x.ts` is `src/b/x.ts`, and `a.ts => b.ts` is `b.ts`. */
export function renamedPath(path: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (braced !== null) {
    const [, head = '', , to = '', tail = ''] = braced;
    return `${head}${to}${tail}`.replace(/\/{2,}/g, '/');
  }
  const arrow = path.indexOf(' => ');
  return arrow === -1 ? path : path.slice(arrow + ' => '.length);
}

/** Whether a path matches one of the patterns (the team's tests or sources), read with forward slashes where a rename ends. */
export function pathMatcher(patterns: readonly string[]): (path: string) => boolean {
  const compiled = patterns.map((pattern) => new RegExp(pattern, 'u'));
  return (path) => {
    const normal = renamedPath(path).replace(/\\/g, '/');
    return compiled.some((pattern) => pattern.test(normal));
  };
}

/** The changed non-test lines (added + deleted) and non-test files; a binary file counts as a file with no lines. */
export function weighCommit(commit: CommitStat, isTest: (path: string) => boolean): CommitWeight {
  const counted = commit.files.filter((file) => !isTest(file.path));
  return {
    lines: counted.reduce((sum, file) => sum + (file.added ?? 0) + (file.deleted ?? 0), 0),
    files: counted.length,
  };
}

/** Whether the body has a `<trailer>: <reason>` line with a reason; the key matches in any case, as git trailers do. */
export function hasLargeReason(body: string, trailer: string): boolean {
  const key = `${trailer.toLowerCase()}:`;
  return body.split(/\r?\n/).some((line) => line.toLowerCase().startsWith(key) && line.slice(key.length).trim() !== '');
}

/** The commits over either bound with no reason line, in the order given. */
export function largeCommits(commits: readonly CommitStat[], rule: CommitSizeRule): LargeCommit[] {
  const isTest = pathMatcher(rule.testPatterns);
  return commits.flatMap((commit) => {
    const weight = weighCommit(commit, isTest);
    const large = weight.lines > rule.maxLines || weight.files > rule.maxFiles;
    return large && !hasLargeReason(commit.body, rule.largeCommitTrailer) ? [{ sha: commit.sha, subject: commit.subject, ...weight }] : [];
  });
}

/** One message naming the large commits (the first five, then a count) and what would let each through. */
export function describeLargeCommits(large: readonly LargeCommit[], rule: CommitSizeRule): string {
  const named = large.slice(0, NAMED_MAX).map((commit) => {
    const subject = commit.subject.length > SUBJECT_MAX ? `${commit.subject.slice(0, SUBJECT_MAX - 1)}…` : commit.subject;
    return `${commit.sha.slice(0, 7)} "${subject}" (${commit.lines} line(s), ${commit.files} file(s))`;
  });
  const more = large.length > NAMED_MAX ? `, and ${large.length - NAMED_MAX} more` : '';
  return (
    `${large.length} commit(s) go over ${rule.maxLines} changed non-test lines or ${rule.maxFiles} non-test files with no "${rule.largeCommitTrailer}: <reason>" line: ${named.join('; ')}${more}.` +
    ' Split each into logical steps, or give the reason in its message.'
  );
}

/** Reads `git log --numstat --format=<COMMIT_LOG_FORMAT>` output. */
export function parseCommitLog(text: string): CommitStat[] {
  return text
    .split('\x1e')
    .slice(1)
    .flatMap((record) => {
      const [sha = '', subject = '', body = '', stats = ''] = record.split('\x1f');
      return sha === '' ? [] : [{ sha, subject, body: body.trim(), files: stats.split('\n').flatMap(parseNumstat) }];
    });
}

/** One `<added>\t<deleted>\t<path>` line; `-` counts mark a binary file. Anything else is skipped. */
function parseNumstat(line: string): FileChange[] {
  const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.replace(/\r$/, ''));
  if (match === null) {
    return [];
  }
  const [, added = '-', deleted = '-', path = ''] = match;
  return [{ path, added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) }];
}
