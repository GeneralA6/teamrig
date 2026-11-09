import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bashToolReadings, halvedBackslashRuns, toolCommandReadings } from './bash-tool-readings.ts';

/** A run of n backslashes, so each case shows its count rather than an escaped literal. */
const bs = (n: number): string => '\\'.repeat(n);

describe('halvedBackslashRuns', () => {
  it('halves each run not followed by a double quote, rounded up, as Git Bash received them', () => {
    for (const [typed, received] of [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3]] as const) {
      assert.equal(halvedBackslashRuns(`a${bs(typed)}b`), `a${bs(received)}b`, `${typed} backslashes`);
    }
  });

  it('halves a run inside single quotes and a run at the end of the line too', () => {
    assert.equal(halvedBackslashRuns(`echo 'a${bs(2)}b'`), `echo 'a${bs(1)}b'`);
    assert.equal(halvedBackslashRuns(`echo two${bs(4)}`), `echo two${bs(2)}`);
  });

  it('keeps a run followed by a double quote', () => {
    assert.equal(halvedBackslashRuns(`echo "a${bs(2)}" 'b'`), `echo "a${bs(2)}" 'b'`);
    assert.equal(halvedBackslashRuns(`echo 'q${bs(2)}"r'`), `echo 'q${bs(2)}"r'`);
  });

  it('turns an escaped separator or backtick into a live one, as the probe showed', () => {
    assert.equal(halvedBackslashRuns(`ls a${bs(3)}; rm -f x`), `ls a${bs(2)}; rm -f x`);
    assert.equal(halvedBackslashRuns(`echo "p${bs(3)}\`rm x${bs(3)}\`q"`), `echo "p${bs(2)}\`rm x${bs(2)}\`q"`);
  });
});

describe('bashToolReadings', () => {
  it('gives the command alone off Windows, and on Windows when halving changes nothing', () => {
    assert.deepEqual(bashToolReadings(`ls a${bs(3)}; rm -f x`, 'linux'), [`ls a${bs(3)}; rm -f x`]);
    assert.deepEqual(bashToolReadings('grep -n x f', 'win32'), ['grep -n x f']);
    assert.deepEqual(bashToolReadings(`grep "x${bs(2)}" f`, 'win32'), [`grep "x${bs(2)}" f`]);
  });

  it('adds the halved text on Windows, after the command as written', () => {
    assert.deepEqual(bashToolReadings(`ls a${bs(3)}; rm -f x`, 'win32'), [`ls a${bs(3)}; rm -f x`, `ls a${bs(2)}; rm -f x`]);
  });
});

describe('toolCommandReadings', () => {
  it("gives a Bash call's readings, halved on Windows", () => {
    assert.deepEqual(toolCommandReadings('Bash', `ls a${bs(3)}; rm -f x`, 'win32'), [`ls a${bs(3)}; rm -f x`, `ls a${bs(2)}; rm -f x`]);
    assert.deepEqual(toolCommandReadings('Bash', `ls a${bs(3)}; rm -f x`, 'linux'), [`ls a${bs(3)}; rm -f x`]);
  });

  it("gives any other tool's command as written, on Windows too", () => {
    assert.deepEqual(toolCommandReadings('PowerShell', `ls a${bs(3)}; rm -f x`, 'win32'), [`ls a${bs(3)}; rm -f x`]);
    assert.deepEqual(toolCommandReadings(undefined, `ls a${bs(3)}`, 'win32'), [`ls a${bs(3)}`]);
  });
});
