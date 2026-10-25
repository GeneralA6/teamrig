import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGISTER } from '../config/defaults.ts';
import { testTask } from '../testing/task.ts';
import { bugHint } from './bug-hint.ts';

const PATTERN = DEFAULT_REGISTER.review.hintPattern;

describe('bugHint', () => {
  it('asks to mark an untyped task whose title reads like a bug, naming the word and the command', () => {
    assert.equal(
      bugHint(testTask({ id: 'T7', title: 'Fix the stale lock' }), PATTERN),
      'T7 looks like a bug ("Fix"): mark it with teamrig update T7 --type bug [--critical], or --type task',
    );
  });

  it('reads the description when the title says nothing, case-insensitively', () => {
    const hint = bugHint(testTask({ id: 'T7', title: 'Nightly rescoring', description: 'The run CRASHED twice this week.' }), PATTERN);
    assert.match(hint ?? '', /^T7 looks like a bug \("CRASHED"\)/);
  });

  it('stays quiet on a typed task, a task included, and on text that matches nothing', () => {
    assert.equal(bugHint(testTask({ title: 'Fix the stale lock', type: 'task' }), PATTERN), undefined, '--type task');
    assert.equal(bugHint(testTask({ title: 'Fix the stale lock', type: 'bug', critical: true }), PATTERN), undefined);
    assert.equal(bugHint(testTask({ title: 'Add a health check', description: 'Users ask for it.' }), PATTERN), undefined);
    assert.equal(bugHint(testTask({ title: 'Prefix the ids' }), PATTERN), undefined, 'a word inside another word is no match');
  });

  it("matches the team's own pattern", () => {
    assert.match(bugHint(testTask({ title: 'Outage at the gateway' }), String.raw`\boutage\b`) ?? '', /\("Outage"\)/);
  });
});
