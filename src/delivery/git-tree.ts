import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { CheckedTree, TreeState } from './push-pass.ts';
import type { RunTree } from './run-tree.ts';

/** One git run's stdout; any failure (no repository, no commit, no git on PATH) reads as undefined. */
function runGit(dir: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: dir, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/**
 * git prints its top level with forward slashes on Windows too (`C:/work/repo`); resolved, it names the place the
 * way the log's folder line does (`C:\\work\\repo`).
 */
export function nativeTop(shown: string, resolvePath: (path: string) => string = resolve): string {
  return resolvePath(shown);
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
  ranIn: (dir): RunTree => {
    const shown = runGit(dir, ['rev-parse', '--show-toplevel'])?.trim();
    if (shown === undefined || shown === '') {
      return { kind: 'outside' };
    }
    const top = nativeTop(shown);
    const head = runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim();
    const status = runGit(dir, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']);
    // A status git cannot give reads as dirty: a log never calls a tree clean that nobody saw.
    return { kind: 'git', top, head: head === undefined || head === '' ? null : head, dirty: status !== '' };
  },
};
