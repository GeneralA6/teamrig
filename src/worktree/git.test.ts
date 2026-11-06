import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TempRepo } from '../../tools/lib/temp-repo.ts';
import { GIT_WORKTREES as git, parseStatus, parseWorktreeList } from './git.ts';

describe('parseWorktreeList', () => {
  it('reads each worktree with its branch and lock, the main one first', () => {
    const text = [
      'worktree C:/src/app',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree C:/src/app-t4',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/t4-parser',
      'locked',
      '',
      'worktree C:/src/app-spike',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'locked on a laptop',
      '',
      '',
    ].join('\r\n');
    assert.deepEqual(parseWorktreeList(text), [
      { path: 'C:/src/app', branch: 'main', locked: undefined },
      { path: 'C:/src/app-t4', branch: 't4-parser', locked: '' },
      { path: 'C:/src/app-spike', branch: undefined, locked: 'on a laptop' },
    ]);
  });

  it('reads a bare main repository, and skips a block with no worktree line', () => {
    assert.deepEqual(parseWorktreeList('worktree /srv/app.git\nbare\n\nprunable gone\n'), [{ path: '/srv/app.git', branch: undefined, locked: undefined }]);
  });
});

describe('parseStatus', () => {
  it('reads every changed path, a rename once', () => {
    assert.deepEqual(parseStatus('?? new.txt\0 M src/a.ts\0R  b-new.ts\0b-old.ts\0 C c-copy.ts\0c.ts\0D  gone.ts\0'), ['new.txt', 'src/a.ts', 'b-new.ts', 'c-copy.ts', 'gone.ts']);
    assert.deepEqual(parseStatus(''), []);
  });
});

/** A repo on `main` with one commit and a linked worktree on `feat`, beside it in the temp folder. */
function repoWithWorktree(prefix: string): { repo: TempRepo; worktree: string } {
  const repo = new TempRepo(prefix).init();
  repo.git('checkout', '-q', '-b', 'main');
  repo.write('a.txt', 'a\n');
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'first');
  const worktree = join(repo.outside, 'feat');
  repo.git('worktree', 'add', '-q', '-b', 'feat', worktree);
  return { repo, worktree };
}

describe('GIT_WORKTREES', () => {
  it('finds the top folder and lists the worktrees, the main one first', () => {
    const { repo, worktree } = repoWithWorktree('wt-list');
    try {
      const top = git.topOf(worktree);
      assert.ok(top !== undefined);
      assert.equal(realpathSync.native(top), realpathSync.native(worktree));
      const listed = git.worktrees(worktree) ?? [];
      assert.deepEqual(
        listed.map((entry) => [realpathSync.native(entry.path), entry.branch, entry.locked]),
        [
          [realpathSync.native(repo.dir), 'main', undefined],
          [realpathSync.native(worktree), 'feat', undefined],
        ],
      );
    } finally {
      repo.remove();
    }
  });

  it('lists changes, leaving out excluded paths, and the files git tracks', () => {
    const { repo, worktree } = repoWithWorktree('wt-status');
    try {
      assert.deepEqual(git.changes(worktree, []), []);
      repo.git('-C', worktree, 'mv', 'a.txt', 'b.txt');
      writeFileSync(join(worktree, 'new.txt'), 'new\n');
      assert.deepEqual([...(git.changes(worktree, []) ?? [])].sort(), ['b.txt', 'new.txt']);
      assert.deepEqual(git.changes(worktree, ['new.txt']), ['b.txt']);
      assert.deepEqual(git.tracked(repo.dir, ['a.txt', 'missing']), ['a.txt']);
      assert.deepEqual(git.tracked(repo.dir, []), []);
    } finally {
      repo.remove();
    }
  });

  it('reads the branch origin/HEAD names, when it names one', () => {
    const { repo } = repoWithWorktree('wt-base');
    try {
      assert.equal(git.defaultBase(repo.dir), undefined);
      repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      assert.equal(git.defaultBase(repo.dir), 'origin/main');
    } finally {
      repo.remove();
    }
  });

  it('counts the commits of a branch not on its base: by ancestry, or as the same patch under a new id', () => {
    const { repo, worktree } = repoWithWorktree('wt-merged');
    try {
      assert.equal(git.commitsNotOn(repo.dir, 'feat', 'main'), 0, 'no commits of its own');
      writeFileSync(join(worktree, 'b.txt'), 'b\n');
      repo.git('-C', worktree, 'add', '-A');
      repo.git('-C', worktree, 'commit', '-q', '-m', 'b');
      assert.equal(git.commitsNotOn(repo.dir, 'feat', 'main'), 1);
      repo.write('c.txt', 'c\n');
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', 'c on main');
      repo.git('cherry-pick', 'feat');
      assert.equal(git.commitsNotOn(repo.dir, 'feat', 'main'), 0, 'a rebase merge leaves the same patch');
      assert.equal(git.commitsNotOn(repo.dir, 'no-such-branch', 'main'), undefined);
      assert.equal(git.commitsNotOn(repo.dir, 'feat', 'no-such-base'), undefined);
    } finally {
      repo.remove();
    }
  });

  it("counts the commits of a worktree's detached HEAD not on a base, as it counts a branch's (T1856)", () => {
    const { repo, worktree } = repoWithWorktree('wt-head-merged');
    try {
      repo.git('-C', worktree, 'switch', '--detach', '-q');
      assert.equal(git.headCommitsNotOn(worktree, 'main'), 0, "detached at main's commit");
      writeFileSync(join(worktree, 'b.txt'), 'b\n');
      repo.git('-C', worktree, 'add', '-A');
      repo.git('-C', worktree, 'commit', '-q', '-m', 'b');
      assert.equal(git.headCommitsNotOn(worktree, 'main'), 1, "the worktree's HEAD, not the main checkout's");
      repo.write('c.txt', 'c\n');
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', 'c on main');
      repo.git('cherry-pick', repo.git('-C', worktree, 'rev-parse', 'HEAD').trim());
      assert.equal(git.headCommitsNotOn(worktree, 'main'), 0, 'a rebase merge leaves the same patch');
      assert.equal(git.headCommitsNotOn(worktree, 'no-such-base'), undefined);
    } finally {
      repo.remove();
    }
  });

  it('removes a clean worktree, refuses a dirty one with git\'s reason, and deletes a branch', () => {
    const { repo, worktree } = repoWithWorktree('wt-remove');
    try {
      writeFileSync(join(worktree, 'new.txt'), 'new\n');
      const dirty = git.removeWorktree(repo.dir, worktree);
      assert.equal(dirty.ok, false);
      assert.match(dirty.ok ? '' : dirty.reason, /modified or untracked files/);
      assert.ok(existsSync(worktree));
      repo.git('-C', worktree, 'clean', '-q', '-f');
      assert.deepEqual(git.removeWorktree(repo.dir, worktree), { ok: true });
      assert.equal(existsSync(worktree), false);
      assert.deepEqual(git.deleteBranch(repo.dir, 'feat'), { ok: true });
      const again = git.deleteBranch(repo.dir, 'feat');
      assert.match(again.ok ? '' : again.reason, /not found/);
    } finally {
      repo.remove();
    }
  });

  it('adds a worktree on a new branch from the fetched default branch, with no upstream (T1305)', () => {
    const { repo } = repoWithWorktree('wt-add');
    const origin = new TempRepo('wt-add-origin').init();
    try {
      origin.git('checkout', '-q', '-b', 'main');
      origin.write('o.txt', 'o\n');
      origin.git('add', '-A');
      origin.git('commit', '-q', '-m', 'on origin');
      repo.git('remote', 'add', 'origin', origin.dir);
      assert.equal(git.hasBranch(repo.dir, 'feat'), true);
      assert.equal(git.hasBranch(repo.dir, 't9-new'), false);
      assert.deepEqual(git.fetch(repo.dir, 'origin', 'main'), { ok: true });
      const path = join(repo.outside, 't9-new');
      assert.deepEqual(git.addWorktree(repo.dir, path, 't9-new', 'origin/main'), { ok: true });
      assert.ok(existsSync(join(path, 'o.txt')), 'checked out from the fetched origin/main');
      assert.equal(repo.git('-C', path, 'branch', '--show-current').trim(), 't9-new');
      assert.equal(repo.git('for-each-ref', '--format=%(upstream)', 'refs/heads/t9-new').trim(), '', 'no upstream until its first push');
      const again = git.addWorktree(repo.dir, join(repo.outside, 't9-again'), 't9-new', 'origin/main');
      assert.match(again.ok ? '' : again.reason, /already exists/);
      assert.equal(git.fetch(repo.dir, 'origin', 'no-such-branch').ok, false);
    } finally {
      repo.remove();
      origin.remove();
    }
  });

  it('reads as unknown where git cannot answer', () => {
    const missing = join(tmpdir(), 'teamrig-no-such-worktree');
    assert.equal(git.topOf(missing), undefined);
    assert.equal(git.worktrees(missing), undefined);
    assert.equal(git.changes(missing, []), undefined);
    assert.equal(git.tracked(missing, ['a.txt']), undefined);
    assert.equal(git.defaultBase(missing), undefined);
    assert.equal(git.hasBranch(missing, 'main'), undefined);
    const failed = git.removeWorktree(missing, join(missing, 'wt'));
    assert.equal(failed.ok, false);
  });
});
