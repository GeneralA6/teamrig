import { readCommits } from '../lib/commits.ts';
import { EXIT_CLEAN, EXIT_FINDINGS } from '../lib/exit.ts';
import type { Git } from '../lib/git.ts';
import { emailFromIdent, signoffProblem } from './signoff.ts';

export interface DcoDeps {
  readonly git: Git;
  readonly readText: (path: string) => Promise<string>;
  readonly out: (line: string) => void;
}

/** The commit-msg hook check: the message being committed must be signed off by its author. */
export async function checkMessageFile(path: string, deps: DcoDeps): Promise<number> {
  const authorEmail = emailFromIdent(await deps.git.text(['var', 'GIT_AUTHOR_IDENT']));
  const problem = signoffProblem(authorEmail, await deps.readText(path));
  if (problem !== undefined) {
    deps.out(`dco: ${problem}`);
    return EXIT_FINDINGS;
  }
  return EXIT_CLEAN;
}

/** The CI check: every non-merge commit in `range` must be signed off by its author. */
export async function checkRange(range: string, deps: DcoDeps): Promise<number> {
  const commits = (await readCommits(deps.git, range)).filter((commit) => commit.parents.length <= 1);
  let failures = 0;
  for (const commit of commits) {
    const problem = signoffProblem(commit.authorEmail, commit.message);
    if (problem !== undefined) {
      failures += 1;
      deps.out(`dco: ${commit.sha.slice(0, 12)} ${problem}`);
    }
  }
  deps.out(
    failures === 0
      ? `dco: ${commits.length} commit(s) signed off`
      : `dco: ${failures} of ${commits.length} commit(s) not signed off`,
  );
  return failures === 0 ? EXIT_CLEAN : EXIT_FINDINGS;
}
