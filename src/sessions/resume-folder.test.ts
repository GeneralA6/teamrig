import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resumeFolderOf } from './resume-folder.ts';

const PROJECTS = 'C:\\Users\\me\\.claude\\projects';
const PROJECT = 'C:\\Work\\app';
const SESSION = '5bdb1411-851d-413b-86ae-cd2e6d25186d.jsonl';

function lines(...cwds: readonly string[]): string {
  return `${cwds.map((cwd) => JSON.stringify({ type: 'assistant', cwd, message: { role: 'assistant', content: [] } })).join('\n')}\n`;
}

function resume(projectFolder: string, tail: string): string | undefined {
  return resumeFolderOf(`${PROJECTS}\\${projectFolder}\\${SESSION}`, tail, PROJECT, PROJECTS, 'win32');
}

describe('resumeFolderOf', () => {
  it('resumes in the project when its project folder holds the transcript, whatever the entries say', () => {
    assert.equal(resume('C--Work-app', ''), PROJECT);
    assert.equal(resume('c--work-app', lines('C:\\Work\\app\\.claude\\worktrees\\fix')), PROJECT, 'Windows paths ignore case');
  });

  it('resumes in the worktree its entries ran in when Claude Code filed the transcript there (T1408)', () => {
    const worktree = 'C:\\Work\\app\\api\\.claude\\worktrees\\t1338-dates';
    assert.equal(resume('C--Work-app-api--claude-worktrees-t1338-dates', lines('C:\\Work\\app', worktree)), worktree);
  });

  it('resumes in a parent of the folder its entries ran in: a session started in a subfolder that moved into a worktree', () => {
    assert.equal(resume('C--Work-app-api', lines('C:\\Work\\app\\api\\.claude\\worktrees\\screen')), 'C:\\Work\\app\\api');
  });

  it('takes the newest entry first, and finds none when no folder it ran in files the transcript there', () => {
    assert.equal(resume('C--Work-app-api-src', lines('C:\\Work\\app\\api\\src', 'C:\\Work\\app\\api\\src\\deep')), 'C:\\Work\\app\\api\\src');
    assert.equal(resume('C--Work-other', lines('C:\\Work\\app\\api', '{', '')), undefined);
    assert.equal(resume('C--Work-other', 'not json\n{"cwd":""}\n{"cwd":7}\n'), undefined);
  });

  it('reads POSIX folders by their own rules', () => {
    const tail = lines('/home/me/app/api/.worktrees/fix');
    assert.equal(resumeFolderOf(`/home/me/.claude/projects/-home-me-app-api/${SESSION}`, tail, '/home/me/app', '/home/me/.claude/projects', 'linux'), '/home/me/app/api');
    assert.equal(resumeFolderOf(`/home/me/.claude/projects/-home-me-App-api/${SESSION}`, tail, '/home/me/app', '/home/me/.claude/projects', 'linux'), undefined, 'a case-sensitive filesystem');
  });
});
