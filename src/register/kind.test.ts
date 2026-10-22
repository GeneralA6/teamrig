import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGISTER } from '../config/defaults.ts';
import { testTask } from '../testing/task.ts';
import { problemHint } from './kind.ts';

const PATTERN = DEFAULT_REGISTER.review.hintPattern;

describe('problemHint', () => {
  it('asks to mark an unmarked task whose title reads like a problem, naming the word and the command', () => {
    assert.equal(
      problemHint(testTask({ id: 'T7', title: 'Fix the stale lock' }), PATTERN),
      'T7 looks like a problem ("Fix"): mark it with teamrig update T7 --problem problem|critical, or --problem none',
    );
  });

  it('reads the description when the title says nothing, case-insensitively', () => {
    const hint = problemHint(testTask({ id: 'T7', title: 'Nightly rescoring', description: 'The run CRASHED twice this week.' }), PATTERN);
    assert.match(hint ?? '', /^T7 looks like a problem \("CRASHED"\)/);
  });

  it('stays quiet on a marked task, work included, and on text that matches nothing', () => {
    assert.equal(problemHint(testTask({ title: 'Fix the stale lock', kind: 'work' }), PATTERN), undefined, '--problem none');
    assert.equal(problemHint(testTask({ title: 'Fix the stale lock', kind: 'critical' }), PATTERN), undefined);
    assert.equal(problemHint(testTask({ title: 'Add a health check', description: 'Users ask for it.' }), PATTERN), undefined);
    assert.equal(problemHint(testTask({ title: 'Prefix the ids' }), PATTERN), undefined, 'a word inside another word is no match');
  });

  it("matches the team's own pattern", () => {
    assert.match(problemHint(testTask({ title: 'Outage at the gateway' }), String.raw`\boutage\b`) ?? '', /\("Outage"\)/);
  });
});
