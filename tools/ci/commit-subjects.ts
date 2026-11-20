import { unreadRange, type CommitLog } from '../../src/push-guard/commit-size.ts';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import type { Revisions } from './github-range.ts';

/**
 * The commit types a subject may start with. The release workflow (release-please) reads them from main's log:
 * a `feat` raises the minor, a `fix` or `perf` the patch, a `!` after the type or area marks a change that breaks
 * how people use teamrig, and the rest raise nothing on their own.
 */
export const COMMIT_TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert'] as const;

const SUBJECT = /^(?<type>[a-z]+)(?:\((?<area>[\w./-]+)\))?!?: \S/;
const TYPED = new Set<string>(COMMIT_TYPES);

/** How to reword a commit that is already in a branch: the one fix a contributor needs, said once. */
export const REWORD_HELP =
  'reword it as <type>(<area>): <what>, such as "fix(ship): ..." or "docs: ...", the area optional; ' +
  'for the last commit `git commit --amend`, for an older one `git rebase -i <base>` and mark it reword, then push the branch again with --force-with-lease';

/** What is wrong with a subject, or null when release-please can read it. */
export function subjectProblem(subject: string): string | null {
  const match = SUBJECT.exec(subject);
  const type = match?.groups?.['type'];
  if (type === undefined) return 'it does not start with <type>: or <type>(<area>):';
  if (!TYPED.has(type)) return `"${type}" is no commit type; use one of ${COMMIT_TYPES.join(', ')}`;
  return null;
}

export interface CommitSubjectsDeps {
  /** The repository the commits are read from. */
  readonly dir: string;
  readonly commitLog: CommitLog;
  readonly out: (line: string) => void;
}

/**
 * Fails each commit in base..head whose subject is no Conventional Commit, since the release workflow raises the
 * version from those subjects and a pull request is rebase-merged with its commits as they are. A run with no base
 * (a run by hand, as on the release pull request) checks the head commit alone.
 */
export function checkCommitSubjects(ends: Revisions, deps: CommitSubjectsDeps): number {
  const base = ends.base ?? `${ends.head}~1`;
  const range = `${base}..${ends.head}`;
  const read = deps.commitLog.between(deps.dir, base, ends.head);
  if (read.kind !== 'listed') throw new Error(unreadRange(read, `the commits in ${range}`));
  const { commits } = read;
  const wrong = commits.flatMap((commit) => {
    const problem = subjectProblem(commit.subject);
    return problem === null ? [] : [`  ${commit.sha.slice(0, 9)} "${commit.subject}": ${problem}`];
  });
  if (wrong.length > 0) {
    deps.out(`commit-subjects: ${wrong.length} of ${commits.length} commit(s) in ${range} have a subject the release workflow cannot read:`);
    for (const line of wrong) deps.out(line);
    deps.out(`commit-subjects: ${REWORD_HELP}`);
    return EXIT_FINDINGS;
  }
  deps.out(`commit-subjects: ${commits.length} commit(s) in ${range}, each subject <type>(<area>): <what>`);
  return EXIT_CLEAN;
}
