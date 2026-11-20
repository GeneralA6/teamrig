import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as nodePath from 'node:path';
import { hookEventOf } from '../testing/host.ts';
import { cdCompoundForm, cdCompoundOf, cdCompoundOfEvent, cdCompoundReason, guardsCdCompound, type SessionPlace } from './cd-compound.ts';

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

/**
 * The shape of the line that held the lead's tab at Claude Code's prompt for 14 hours (T1749): no leading `cd D &&`,
 * a folder only known when it runs, a second `cd` mid-line, `;` between them, so no rerun form.
 */
const HELD = [
  'set -e; S=/c/Users/me/scratch/t1545; rm -rf "${S:?}"; mkdir -p "$S"; cd "$S"',
  'git init -q --bare origin.git; git clone -q origin.git work; cd work',
  'git config user.name t; git commit -q --allow-empty -m one; git tag v0.1',
  'git push origin main v0.1',
].join('\n');

describe('cdCompoundOf', () => {
  it('gives the rerun form when the line has one', () => {
    assert.deepEqual(cdCompoundOf('cd sub && git status', POSIX), { kind: 'rerun', form: 'git -C sub status' });
    assert.deepEqual(cdCompoundOf(STALLED, WINDOWS), { kind: 'rerun', form: STALLED_FORM });
  });

  // T2802: with no form the line went on to Claude Code's prompt, which held the lead's tab 14 hours.
  it('tells the session to drop the cd of the line that held the lead tab, which has no rerun form', () => {
    assert.equal(cdCompoundForm(HELD, POSIX), undefined);
    assert.deepEqual(cdCompoundOf(HELD, POSIX), { kind: 'drop-cd' });
    assert.deepEqual(cdCompoundOf(HELD, WINDOWS), { kind: 'drop-cd' });
  });

  it('refuses a line with no form whose cd runs git after it, inside the folder too', () => {
    for (const command of ['set -e; cd sub; git status', 'npm ci && cd sub && git log -1', 'cd sub && git status > out.txt', '(cd sub && git status)']) {
      assert.deepEqual(cdCompoundOf(command, POSIX), { kind: 'drop-cd' }, command);
    }
  });

  it('refuses a line with no form whose cd may leave the folder: a run-time folder, home, -, an option, or out', () => {
    for (const command of [
      'cd "$S" && npm test',
      'cd $(mktemp -d) && npm test',
      'cd && ls',
      'cd ~/w && ls',
      'cd - && ls',
      'cd -P /other && ls',
      'ls; cd /other && npm test',
      'cd /other && ls *.ts',
      'cd sub && cd ../.. && ls',
      '(cd /other && make)',
      'npm test; cd ..',
    ]) {
      assert.deepEqual(cdCompoundOf(command, POSIX), { kind: 'drop-cd' }, command);
    }
    assert.deepEqual(cdCompoundOf('npm ci; cd /c/Projects/other; npm test', WINDOWS), { kind: 'drop-cd' });
  });

  it('lets go a cd alone, a line with no cd, and one whose cds stay in the folder and run no git', () => {
    for (const command of [
      'cd /other',
      'cd "$S"',
      'git status',
      'echo cd /other && git status',
      'git status; cd sub',
      'cd sub && npm test',
      'cd sub; npm test | tail -5',
      'cd sub && cd .. && npm test',
      'cd sub/deeper && cd ../.. && ls',
      '(cd sub && npm test); ls',
    ]) {
      assert.equal(cdCompoundOf(command, POSIX), undefined, command);
    }
    assert.equal(cdCompoundOf('npm ci; cd /c/work/APP/src; npm test', WINDOWS), undefined, 'Windows names folders in any case');
  });
});

describe('cdCompoundOfEvent', () => {
  const lineOf = (command: string) => hookEventOf({ tool_name: 'Bash', tool_input: { command } });

  it("reads the line of a hook event's shell call, and gives none without one", () => {
    assert.deepEqual(cdCompoundOfEvent(lineOf('cd sub && git status'), POSIX), { kind: 'rerun', form: 'git -C sub status' });
    assert.deepEqual(cdCompoundOfEvent(lineOf('cd "$S" && npm test'), POSIX), { kind: 'drop-cd' });
    assert.equal(cdCompoundOfEvent(hookEventOf({ tool_name: 'Bash', tool_input: {} }), POSIX), undefined);
    assert.equal(cdCompoundOfEvent(hookEventOf({ tool_name: 'Read', tool_input: { command: 'cd sub && git status' } }), POSIX), undefined);
    assert.equal(cdCompoundOfEvent(hookEventOf({}), POSIX), undefined);
  });
});

describe('guardsCdCompound', () => {
  it('looks only at a bash call about to run, with the switch on', () => {
    const bash = { hook_event_name: 'PreToolUse', tool_name: 'Bash' };
    assert.equal(guardsCdCompound(true, hookEventOf(bash)), true);
    assert.equal(guardsCdCompound(false, hookEventOf(bash)), false);
    assert.equal(guardsCdCompound(true, hookEventOf({ ...bash, tool_name: 'PowerShell' })), false);
    assert.equal(guardsCdCompound(true, hookEventOf({ ...bash, hook_event_name: 'PostToolUse' })), false);
    assert.equal(guardsCdCompound(true, hookEventOf({ hook_event_name: 'PreToolUse' })), false);
  });
});

describe('cdCompoundReason', () => {
  it('says why and quotes the form to rerun', () => {
    const reason = cdCompoundReason({ kind: 'rerun', form: 'git -C /w status' });
    assert.match(reason, /^teamrig picker guard: Claude Code asks a person before a `cd` compound/);
    assert.match(reason, /Do not retry this line; rerun it as: git -C \/w status$/);
  });

  it('says why and how to run the line with no cd when it has no form', () => {
    const reason = cdCompoundReason({ kind: 'drop-cd' });
    assert.match(reason, /^teamrig picker guard: Claude Code asks a person before a `cd` compound/);
    assert.match(reason, /Do not retry this line; a folder only known when it runs counts as leaving\. Drop the `cd`: run git as `git -C <dir> \.\.\.`/);
    assert.match(reason, /`env -C <dir> <command>`, or name files by absolute path\.$/);
  });

  it('never sends the line into a script file, which the guards read less of than the line (T3291)', () => {
    assert.doesNotMatch(cdCompoundReason({ kind: 'drop-cd' }), /script/);
  });
});
