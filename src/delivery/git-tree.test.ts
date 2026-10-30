import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import { GIT_TREES } from './git-tree.ts';

/** A repo with one commit holding a.txt. */
function committed(prefix: string): TempRepo {
  const repo = new TempRepo(prefix).init();
  repo.write('a.txt', 'a');
  repo.git('add', 'a.txt');
  repo.git('commit', '-q', '-m', 'first');
  return repo;
}

describe('GIT_TREES', () => {
  it('reads no repository where git cannot run, and before the first commit', () => {
    assert.deepEqual(GIT_TREES.checked(join(tmpdir(), 'teamrig-no-such-folder')), { kind: 'none' });
    const repo = new TempRepo('tree-empty').init();
    try {
      assert.deepEqual(GIT_TREES.checked(repo.dir), { kind: 'none' });
    } finally {
      repo.remove();
    }
  });

  it("reads a clean tree with HEAD's commit and tree ids and the repository's git folder", () => {
    const repo = committed('tree-clean');
    try {
      assert.deepEqual(GIT_TREES.checked(repo.dir), {
        kind: 'clean',
        tree: repo.git('rev-parse', 'HEAD^{tree}').trim(),
        commit: repo.git('rev-parse', 'HEAD').trim(),
        gitDir: repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
      });
    } finally {
      repo.remove();
    }
  });

  it('reads a changed tree for an edited file, a staged one and an untracked one', () => {
    const repo = committed('tree-changed');
    try {
      repo.write('a.txt', 'edited');
      assert.deepEqual(GIT_TREES.checked(repo.dir), { kind: 'changed' });
      repo.git('add', 'a.txt');
      assert.deepEqual(GIT_TREES.checked(repo.dir), { kind: 'changed' });
      repo.git('commit', '-q', '-m', 'second');
      repo.write('b.txt', 'new');
      assert.deepEqual(GIT_TREES.checked(repo.dir), { kind: 'changed' });
    } finally {
      repo.remove();
    }
  });

  it('reads an untracked file even where the config hides untracked files from status', () => {
    const repo = committed('tree-untracked');
    try {
      repo.git('config', 'status.showUntrackedFiles', 'no');
      repo.write('b.txt', 'new');
      assert.deepEqual(GIT_TREES.checked(repo.dir), { kind: 'changed' });
    } finally {
      repo.remove();
    }
  });

  it("reads a worktree's tree with the git folder of its main checkout, so its passes are shared", () => {
    const repo = committed('tree-worktree');
    try {
      repo.git('worktree', 'add', '-q', join(repo.outside, 'wt'));
      const main = GIT_TREES.checked(repo.dir);
      const worktree = GIT_TREES.checked(join(repo.outside, 'wt'));
      assert.equal(main.kind, 'clean');
      assert.deepEqual(worktree, main);
    } finally {
      repo.remove();
    }
  });
});
