import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeMergeGit, MAIN_CHECKOUT, WORKTREE } from '../testing/fake-merge-git.ts';
import { behindLine, behindMain } from './behind-main.ts';

/** The fake repository with origin's `main` last fetched at `newer`, three commits past both checkouts. */
function fetchedAhead(): FakeMergeGit {
  const git = new FakeMergeGit();
  git.tracking.set('origin/main', 'newer');
  git.landed = ['one', 'two', 'three'];
  return git;
}

describe('behindMain: the commits of main a checkout lacks, as last fetched (T1006)', () => {
  it("counts the commits of origin's default branch the checkout lacks, for a worktree and the main checkout", () => {
    const git = fetchedAhead();
    assert.deepEqual(behindMain(git, WORKTREE), { branch: 'feat', base: 'origin/main', commits: 3 });
    assert.deepEqual(behindMain(git, MAIN_CHECKOUT), { branch: 'main', base: 'origin/main', commits: 3 });
    git.defaultName = 'trunk';
    git.tracking.set('origin/trunk', 'newer');
    assert.deepEqual(behindMain(git, WORKTREE), { branch: 'feat', base: 'origin/trunk', commits: 3 }, "origin's default branch, not a fixed main");
  });

  it('says nothing for a checkout at main, outside a repository, or where main was never fetched', () => {
    const atMain = fetchedAhead();
    atMain.heads.set(WORKTREE, 'newer');
    assert.equal(behindMain(atMain, WORKTREE), undefined, 'none to take');
    assert.equal(behindMain(fetchedAhead(), '/not/a/repo'), undefined, 'no repository');
    assert.equal(behindMain(new FakeMergeGit(), WORKTREE), undefined, 'no origin/main ref yet');
    assert.deepEqual(new FakeMergeGit().log, [], 'it reads and never fetches');
  });

  it('names the branch, or a detached HEAD, with the count and the step to take', () => {
    assert.equal(behindLine({ branch: 'feat', base: 'origin/main', commits: 3 }), 'BEHIND feat is 3 commit(s) behind origin/main as last fetched: rebase before you edit');
    assert.equal(behindLine({ branch: undefined, base: 'origin/main', commits: 1 }), 'BEHIND the detached HEAD is 1 commit(s) behind origin/main as last fetched: rebase before you edit');
  });
});
