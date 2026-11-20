import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bashReadings, halvedBackslashRuns } from './bash-readings.ts';

describe('the text bash receives for a Bash tool command on Windows', () => {
  it('halves each backslash run, rounded up', () => {
    assert.equal(halvedBackslashRuns('ls a\\\\\\; rm -f x'), 'ls a\\\\; rm -f x');
    assert.equal(halvedBackslashRuns('a\\b'), 'a\\b');
    assert.equal(halvedBackslashRuns('a\\\\b'), 'a\\b');
    assert.equal(halvedBackslashRuns('a\\\\\\\\b'), 'a\\\\b');
  });

  it('keeps a run that stands before a double quote', () => {
    assert.equal(halvedBackslashRuns('echo "a\\\\"'), 'echo "a\\\\"');
    assert.equal(halvedBackslashRuns('echo \\\\" \\\\x'), 'echo \\\\" \\x');
  });
});

describe('the readings of a Bash tool command', () => {
  it('are the command as written off Windows', () => {
    assert.deepEqual(bashReadings('ls a\\\\\\; rm -f x', 'linux'), ['ls a\\\\\\; rm -f x']);
    assert.deepEqual(bashReadings('ls a\\\\\\; rm -f x', 'darwin'), ['ls a\\\\\\; rm -f x']);
  });

  it('add the halved text on Windows, when it differs', () => {
    assert.deepEqual(bashReadings('ls a\\\\\\; rm -f x', 'win32'), ['ls a\\\\\\; rm -f x', 'ls a\\\\; rm -f x']);
    assert.deepEqual(bashReadings('git status', 'win32'), ['git status']);
    assert.deepEqual(bashReadings('echo a\\b', 'win32'), ['echo a\\b']);
  });
});
