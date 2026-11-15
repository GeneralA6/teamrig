import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodePath from 'node:path';
import { cdCompoundForm, cdCompoundFormOf, cdCompoundReason, guardsCdCompound, type SessionPlace } from './cd-compound.ts';

const WINDOWS: SessionPlace = { cwd: 'C:\\Work\\app', home: 'C:\\Users\\me', host: nodePath.win32 };
const POSIX: SessionPlace = { cwd: '/work/app', home: '/home/me', host: nodePath.posix };

/** The line that held a session at Claude Code's prompt for 9 hours (T2730), sent with the main checkout as its folder. */
const STALLED = 'cd /c/Projects/teamrig/.worktrees/t2667-public-repo-security && git push -u origin t2667-public-repo-security 2>&1 | tail -8';
const STALLED_FORM =
  'git -C /c/Projects/teamrig/.worktrees/t2667-public-repo-security push -u origin t2667-public-repo-security 2>&1' +
  ' | env -C /c/Projects/teamrig/.worktrees/t2667-public-repo-security tail -8';

describe('cdCompoundForm', () => {
  it('gives the rerun form of the line that held a session at the prompt, its folder written either way', () => {
    assert.equal(cdCompoundForm(STALLED, WINDOWS), STALLED_FORM);
    assert.equal(cdCompoundForm(STALLED, { ...WINDOWS, cwd: '/c/Work/app' }), STALLED_FORM);
  });

  it('gives a form when git runs after the cd, inside the session folder too', () => {
    assert.equal(cdCompoundForm('cd sub && git status', POSIX), 'git -C sub status');
    assert.equal(cdCompoundForm('cd /work/app && npm test && git log -1', POSIX), 'env -C /work/app npm test && git -C /work/app log -1');
    assert.equal(cdCompoundForm('cd /work/app/sub && git worktree remove ../x', POSIX), 'env -C /work/app/sub teamrig worktree remove ../x');
  });

  it('gives a form when the cd leaves the session folder, whatever runs after it', () => {
    assert.equal(cdCompoundForm('cd /other && npm test', POSIX), 'env -C /other npm test');
    assert.equal(cdCompoundForm('cd .. && ls', POSIX), 'env -C .. ls');
    assert.equal(cdCompoundForm('cd ../app2 && ls', POSIX), 'env -C ../app2 ls');
    assert.equal(cdCompoundForm('cd /c/Projects/other && npm test', WINDOWS), 'env -C /c/Projects/other npm test');
    assert.equal(cdCompoundForm('cd D:/teamrig && npm test', WINDOWS), 'env -C D:/teamrig npm test');
  });

  it('gives none for a cd into the session folder or one inside it that runs no git', () => {
    for (const command of ['cd sub && npm test', 'cd /work/app && ls', 'cd ./sub/deeper && npm test | tail -5', 'cd /work/app/..cache && ls']) {
      assert.equal(cdCompoundForm(command, POSIX), undefined, command);
    }
    assert.equal(cdCompoundForm('cd /c/work/APP/src && npm test', WINDOWS), undefined, 'Windows names folders in any case');
    assert.equal(cdCompoundForm('cd C:\\\\Work\\\\app\\\\src && npm test', WINDOWS), undefined);
  });

  it('gives none for a line with no leading cd or no rerun form, which Claude Code decides', () => {
    for (const command of ['git status', 'git worktree remove /x', 'cd /other', 'cd /other; git status', 'cd /other && git status > out.txt', 'cd ~/w && git status', 'cd /other && ls *.ts']) {
      assert.equal(cdCompoundForm(command, POSIX), undefined, command);
    }
  });
});

describe('cdCompoundFormOf', () => {
  it('reads the command of a hook payload, and gives none without one', () => {
    assert.equal(cdCompoundFormOf({ tool_input: { command: 'cd sub && git status' } }, POSIX), 'git -C sub status');
    assert.equal(cdCompoundFormOf({ tool_input: {} }, POSIX), undefined);
    assert.equal(cdCompoundFormOf({}, POSIX), undefined);
  });
});

describe('guardsCdCompound', () => {
  it('looks only at a PreToolUse Bash call with the switch on', () => {
    const bash = { hook_event_name: 'PreToolUse', tool_name: 'Bash' };
    assert.equal(guardsCdCompound(true, bash), true);
    assert.equal(guardsCdCompound(false, bash), false);
    assert.equal(guardsCdCompound(true, { ...bash, tool_name: 'PowerShell' }), false);
    assert.equal(guardsCdCompound(true, { ...bash, hook_event_name: 'PostToolUse' }), false);
  });
});

describe('cdCompoundReason', () => {
  it('says why and quotes the form to rerun', () => {
    const reason = cdCompoundReason('git -C /w status');
    assert.match(reason, /^teamrig picker guard: Claude Code asks a person before a `cd` compound/);
    assert.match(reason, /Do not retry this line; rerun it as: git -C \/w status$/);
  });
});
