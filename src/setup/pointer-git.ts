import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import type { PointerGit, PointerInGit } from './pointer-ignore.ts';

/** One git run's exit code in `dir`; a run git could not start reads as undefined. */
function gitStatus(dir: string, args: readonly string[]): number | undefined {
  try {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 5_000 });
    return 0;
  } catch (error) {
    return error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  }
}

/** The repository's exclude file, as git in `dir` resolves it (a linked worktree shares its main checkout's); undefined outside a repository. */
function excludeFile(dir: string): string | undefined {
  try {
    const path = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
    // git prints it relative to `dir`, or absolute for a linked worktree.
    return path === '' ? undefined : resolve(dir, path);
  } catch {
    return undefined;
  }
}

/** Pointer state from the git CLI: committed, ignored (git exits 0) or not (1); anything else, git could not tell. */
export const GIT_POINTER: PointerGit = {
  state(path): PointerInGit {
    const dir = dirname(path);
    const name = basename(path);
    const exclude = excludeFile(dir);
    if (exclude === undefined) {
      return { kind: 'no-git' };
    }
    if (gitStatus(dir, ['ls-files', '--error-unmatch', '--', name]) === 0) {
      return { kind: 'tracked' };
    }
    switch (gitStatus(dir, ['check-ignore', '-q', '--', name])) {
      case 0:
        return { kind: 'ignored' };
      case 1:
        return { kind: 'open', exclude };
      default:
        return { kind: 'no-git' };
    }
  },
};
