import { basename, dirname, resolve } from 'node:path';
import { queryLine, runGit } from '../core/git-run.ts';
import type { PointerGit, PointerInGit } from './pointer-ignore.ts';

/**
 * git's own exit code in `dir`; undefined when git gave no answer of its own (it did not start, or the kit's query
 * timeout stopped it on a loaded host), which must never read as its "no".
 */
function gitStatus(dir: string, args: readonly string[]): number | undefined {
  const run = runGit(dir, args);
  return run.unanswered === undefined && run.status !== null ? run.status : undefined;
}

/** The repository's exclude file, as git in `dir` resolves it (a linked worktree shares its main checkout's); undefined outside a repository. */
function excludeFile(dir: string): string | undefined {
  const path = queryLine(dir, ['rev-parse', '--git-path', 'info/exclude']);
  // git prints it relative to `dir`, or absolute for a linked worktree.
  return path === undefined ? undefined : resolve(dir, path);
}

/**
 * Pointer state from the git CLI: committed, ignored (git exits 0) or not (1); anything else, git could not tell. Each
 * run goes through the kit's git runner, so git reads the repository `path` is in, never one a caller's git hook names
 * in GIT_DIR, and waits as long as every other git query.
 */
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
