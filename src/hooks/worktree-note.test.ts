import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testPaths } from '../testing/host.ts';
import { WORKTREE_NOTE, worktreeNoteOf } from './worktree-note.ts';

/** The shipped host's paths on Linux, where a folder's name matches only as written. */
const PATHS = testPaths();

describe('worktreeNoteOf', () => {
  it('names the forms the isolation refuses for a folder in a Claude Code worktree, with either separator', () => {
    for (const cwd of ['C:\\work\\api\\.claude\\worktrees\\fix-1', '/work/api/.claude/worktrees/fix-1', '/work/api/.claude/worktrees/fix-1/src']) {
      assert.equal(worktreeNoteOf(cwd, PATHS), WORKTREE_NOTE, cwd);
    }
    assert.match(WORKTREE_NOTE, /not as variables \(or put -- before one\)/);
    assert.match(WORKTREE_NOTE, /git as one plain command from this folder, never with cd or -C into the shared checkout/);
  });

  it('says nothing for a main checkout, a git worktree elsewhere, the worktrees folder itself or no folder', () => {
    for (const cwd of ['/work/api', '/work/.worktrees/fix-1', '/work/api/.claude', '/work/api/.claude/worktrees', '/work/api/.claude/worktrees/', undefined]) {
      assert.equal(worktreeNoteOf(cwd, PATHS), undefined, String(cwd));
    }
  });

  it('matches the folder names in any case on Windows, where the filesystem ignores it, and only as written on Linux', () => {
    const cwd = 'C:\\Work\\Api\\.Claude\\Worktrees\\fix-1';
    assert.equal(worktreeNoteOf(cwd, testPaths({}, 'win32')), WORKTREE_NOTE);
    assert.equal(worktreeNoteOf('/work/api/.Claude/Worktrees/fix-1', PATHS), undefined);
  });

  it('says nothing where the folders of the host are not known: nothing then says the folder is such a worktree', () => {
    assert.equal(worktreeNoteOf('/work/api/.claude/worktrees/fix-1', undefined), undefined);
  });
});
