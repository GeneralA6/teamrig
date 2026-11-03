import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claudeWorktreeRepo, expandHome, homeRelative, isAtOrBelow, pathKey, samePath } from './paths.ts';

describe('isAtOrBelow', () => {
  it('holds for the folder itself and any place inside it, ignoring case and separators on Windows (T1232)', () => {
    assert.ok(isAtOrBelow('C:\\Work\\App\\', 'c:/work/app', 'win32'));
    assert.ok(isAtOrBelow('C:\\Work\\App\\src\\web', 'c:/work/app', 'win32'));
    assert.ok(isAtOrBelow('C:\\work', 'C:\\', 'win32'));
    assert.ok(!isAtOrBelow('C:\\work\\app-api', 'C:\\work\\app', 'win32'));
    assert.ok(!isAtOrBelow('C:\\work', 'C:\\work\\app', 'win32'));
  });

  it('keeps case on Linux', () => {
    assert.ok(isAtOrBelow('/srv/app/src', '/srv/app/', 'linux'));
    assert.ok(isAtOrBelow('/srv', '/', 'linux'));
    assert.ok(!isAtOrBelow('/srv/App/src', '/srv/app', 'linux'));
    assert.ok(!isAtOrBelow('/srv/application', '/srv/app', 'linux'));
  });
});

describe('samePath', () => {
  it('ignores case, separators and a trailing separator on Windows', () => {
    assert.ok(samePath('C:\\Work\\App\\', 'c:/work/app', 'win32'));
    assert.ok(samePath('C:\\work\\src\\..\\app', 'C:\\WORK\\APP', 'win32'));
    assert.ok(!samePath('C:\\work\\app', 'D:\\work\\app', 'win32'));
  });

  it('ignores case on macOS, which uses POSIX paths', () => {
    assert.ok(samePath('/Srv/Work/App/', '/srv/work/app', 'darwin'));
    assert.ok(!samePath('/srv/work/app', '/srv/work/api', 'darwin'));
  });

  it('keeps case on Linux', () => {
    assert.ok(samePath('/srv/work/app/', '/srv/work/./app', 'linux'));
    assert.ok(!samePath('/srv/work/App', '/srv/work/app', 'linux'));
  });
});

describe('pathKey', () => {
  it('is the resolved path, lowercased only where case is ignored', () => {
    assert.equal(pathKey('C:\\Work\\App\\', 'win32'), 'c:\\work\\app');
    assert.equal(pathKey('/Srv/Work/App/', 'darwin'), '/srv/work/app');
    assert.equal(pathKey('/srv/Work/App/', 'linux'), '/srv/Work/App');
  });
});

describe('homeRelative', () => {
  it('writes a path below the home folder from ~ with forward slashes', () => {
    assert.equal(homeRelative('C:\\Users\\user\\.claude\\CLAUDE.md', 'C:\\Users\\user', 'win32'), '~/.claude/CLAUDE.md');
    assert.equal(homeRelative('c:/users/USER/notes.md', 'C:\\Users\\user', 'win32'), '~/notes.md');
    assert.equal(homeRelative('/home/user/work/CLAUDE.md', '/home/user', 'linux'), '~/work/CLAUDE.md');
    assert.equal(homeRelative('/home/user', '/home/user/', 'linux'), '~');
    assert.equal(homeRelative('/home/user/..notes.md', '/home/user', 'linux'), '~/..notes.md');
  });

  it('keeps any other path whole and resolved', () => {
    assert.equal(homeRelative('D:/work/CLAUDE.md', 'C:\\Users\\user', 'win32'), 'D:\\work\\CLAUDE.md');
    assert.equal(homeRelative('/home/username/CLAUDE.md', '/home/user', 'linux'), '/home/username/CLAUDE.md');
    assert.equal(homeRelative('/srv/../etc/CLAUDE.md', '/home/user', 'linux'), '/etc/CLAUDE.md');
  });
});

describe('expandHome', () => {
  it('reads a leading ~ as the home folder', () => {
    assert.equal(expandHome('~/.claude/CLAUDE.md', '/home/user', 'linux'), '/home/user/.claude/CLAUDE.md');
    assert.equal(expandHome('~\\notes.md', 'C:\\Users\\user', 'win32'), 'C:\\Users\\user\\notes.md');
    assert.equal(expandHome('~', '/home/user', 'linux'), '/home/user');
  });

  it('leaves any other path as written', () => {
    assert.equal(expandHome('~user/notes.md', '/home/user', 'linux'), '~user/notes.md');
    assert.equal(expandHome('~\\notes.md', '/home/user', 'linux'), '~\\notes.md');
    assert.equal(expandHome('/srv/CLAUDE.md', '/home/user', 'linux'), '/srv/CLAUDE.md');
  });
});

describe('claudeWorktreeRepo', () => {
  it('reads a path at or below a Claude Code worktree as the same place in its repo (T1593)', () => {
    assert.equal(claudeWorktreeRepo('/work/app/.claude/worktrees/t1', 'linux'), '/work/app');
    assert.equal(claudeWorktreeRepo('/work/app/.claude/worktrees/t1/web/src', 'linux'), '/work/app/web/src');
    assert.equal(claudeWorktreeRepo('C:\\Work\\App\\.claude\\worktrees\\t1', 'win32'), 'C:\\Work\\App');
    assert.equal(claudeWorktreeRepo('C:/Work/App/.claude/worktrees/t1/web', 'win32'), 'C:/Work/App/web');
  });

  it('keeps the root of a repo at a root', () => {
    assert.equal(claudeWorktreeRepo('/.claude/worktrees/t1', 'linux'), '/');
    assert.equal(claudeWorktreeRepo('C:\\.claude\\worktrees\\t1', 'win32'), 'C:\\');
  });

  it('matches the folder names in any case only where the filesystem ignores case', () => {
    assert.equal(claudeWorktreeRepo('C:\\Work\\App\\.Claude\\Worktrees\\t1', 'win32'), 'C:\\Work\\App');
    assert.equal(claudeWorktreeRepo('/work/app/.Claude/Worktrees/t1', 'linux'), undefined);
  });

  it('gives nothing for a path outside a worktree, or the worktrees folder itself', () => {
    assert.equal(claudeWorktreeRepo('/work/app', 'linux'), undefined);
    assert.equal(claudeWorktreeRepo('/work/app/.claude/skills/check', 'linux'), undefined);
    assert.equal(claudeWorktreeRepo('/work/app/.claude/worktrees', 'linux'), undefined);
    assert.equal(claudeWorktreeRepo('/work/app/claude/worktrees/t1', 'linux'), undefined);
  });
});
