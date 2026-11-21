import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bashReadings, halvedBackslashRuns } from './bash-readings.ts';

/** A run of n backslashes, so a case shows its count rather than an escaped literal. */
const bs = (n: number): string => '\\'.repeat(n);

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
    assert.equal(halvedBackslashRuns(`echo 'q${bs(2)}"r'`), `echo 'q${bs(2)}"r'`);
  });

  it('halves a run of any length as Git Bash received it', () => {
    for (const [typed, received] of [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3]] as const) {
      assert.equal(halvedBackslashRuns(`a${bs(typed)}b`), `a${bs(received)}b`, `${typed} backslashes`);
    }
  });

  it('halves a run inside single quotes and a run at the end of the line too', () => {
    assert.equal(halvedBackslashRuns(`echo 'a${bs(2)}b'`), `echo 'a${bs(1)}b'`);
    assert.equal(halvedBackslashRuns(`echo two${bs(4)}`), `echo two${bs(2)}`);
  });

  it('turns an escaped backtick into a live one, as the probe showed', () => {
    assert.equal(halvedBackslashRuns(`echo "p${bs(3)}\`rm x${bs(3)}\`q"`), `echo "p${bs(2)}\`rm x${bs(2)}\`q"`);
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
