import { execFileSync } from 'node:child_process';
import type { RepoState } from './push.ts';

/** One git query; any failure (no repository, no upstream, no git on PATH) reads as unknown. */
function readGit(dir: string, args: readonly string[]): string | undefined {
  try {
    const output = execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
    const value = output.trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Repository state from the git CLI. */
export const GIT_CLI: RepoState = {
  // symbolic-ref names a branch before its first commit, and nothing on a detached HEAD.
  branch: (dir) => readGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD']),
  pushTarget: (dir) => readGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']),
};
