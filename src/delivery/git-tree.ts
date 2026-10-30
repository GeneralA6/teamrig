import { execFileSync } from 'node:child_process';
import type { CheckedTree, TreeState } from './push-pass.ts';

/** One git run's stdout; any failure (no repository, no commit, no git on PATH) reads as undefined. */
function runGit(dir: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** The working tree from the git CLI: HEAD's ids and the shared git folder, and whether anything is uncommitted. */
export const GIT_TREES: TreeState = {
  checked: (dir): CheckedTree => {
    const [gitDir, commit, tree] = runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir', 'HEAD', 'HEAD^{tree}'])?.trim().split(/\r?\n/) ?? [];
    // Optional locks off: this status must not take the index lock that a git command running beside it may need.
    // Untracked files are listed whatever the config says, since the checks test them too.
    const status = runGit(dir, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']);
    if (gitDir === undefined || commit === undefined || tree === undefined || status === undefined) {
      return { kind: 'none' };
    }
    return status === '' ? { kind: 'clean', tree, commit, gitDir } : { kind: 'changed' };
  },
};
