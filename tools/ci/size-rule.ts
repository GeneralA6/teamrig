import { describeLargeCommits, largeCommits, type CommitLog, type CommitSizeRule } from '../../src/push-guard/commit-size.ts';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import type { Revisions } from './github-range.ts';

export interface SizeRuleDeps {
  /** The repository the commits are read from. */
  readonly dir: string;
  readonly commitLog: CommitLog;
  readonly rule: CommitSizeRule;
  readonly out: (line: string) => void;
}

/**
 * The small-commits rule over the commits in base..head, the one the push guard applies: fails each commit over
 * the rule's changed non-test lines or files whose message gives no reason line. A new branch has no base, so
 * there is nothing to compare with.
 */
export function checkCommitSizes(ends: Revisions, deps: SizeRuleDeps): number {
  if (ends.base === undefined) {
    deps.out('size-rule: no base commit to compare with (a new branch), nothing to check');
    return EXIT_CLEAN;
  }
  const range = `${ends.base}..${ends.head}`;
  const commits = deps.commitLog.between(deps.dir, ends.base, ends.head);
  if (commits === undefined) {
    throw new Error(`git cannot list the commits in ${range}`);
  }
  const large = largeCommits(commits, deps.rule);
  if (large.length > 0) {
    deps.out(`size-rule: ${describeLargeCommits(large, deps.rule)}`);
    return EXIT_FINDINGS;
  }
  deps.out(
    `size-rule: ${commits.length} commit(s) in ${range}, none over ${deps.rule.maxLines} changed non-test lines or ${deps.rule.maxFiles} non-test files without a "${deps.rule.largeCommitTrailer}: <reason>" line`,
  );
  return EXIT_CLEAN;
}
