import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TestOutput } from './parse.ts';
import { failureBlocks, formatDuration, headline, labelOf, outputTail, reportLines, TAIL_LINES, type FinishedRun } from './report.ts';

const UNKNOWN: TestOutput = { runner: 'unknown', counts: null, failures: [] };

function run(overrides: Partial<FinishedRun> = {}): FinishedRun {
  return { label: 'npm test', end: { kind: 'exited', code: 0 }, tookMs: 41_000, log: '/kit/logs/test-1.log', output: '', parsed: UNKNOWN, maxFailureChars: 4000, ...overrides };
}

function counted(total: number, failed: number, blocks: readonly string[] = []): TestOutput {
  return { runner: 'node', counts: { total, failed }, failures: blocks };
}

describe('labelOf', () => {
  it('joins the words, and cuts a long command at 60 characters with …', () => {
    assert.equal(labelOf(['npm', 'test']), 'npm test');
    const long = labelOf(['node', '--test', `src/${'a'.repeat(80)}.test.ts`]);
    assert.equal([...long].length, 60);
    assert.ok(long.startsWith('node --test src/aaa') && long.endsWith('a…'));
    assert.equal(labelOf(['x'.repeat(60)]), 'x'.repeat(60));
  });
});

describe('formatDuration', () => {
  it('reads tenths under ten seconds, whole seconds under a minute, then minutes and seconds', () => {
    assert.deepEqual([0, 2_450, 9_949, 9_950, 41_400, 59_499, 59_500, 372_000].map(formatDuration), ['0.0 s', '2.5 s', '9.9 s', '10 s', '41 s', '59 s', '1 min 0 s', '6 min 12 s']);
  });
});

describe('headline', () => {
  it('says PASS with the number of tests, or without when the runner printed none', () => {
    assert.equal(headline(run({ parsed: counted(1532, 0) })), 'PASS npm test: 1,532 tests in 41 s. Log: /kit/logs/test-1.log');
    assert.equal(headline(run({ parsed: counted(1, 0) })), 'PASS npm test: 1 test in 41 s. Log: /kit/logs/test-1.log');
    assert.equal(headline(run()), 'PASS npm test in 41 s. Log: /kit/logs/test-1.log');
  });

  it('says PASS by the exit code, but names failures the output still shows', () => {
    assert.equal(headline(run({ parsed: counted(4, 2) })), 'PASS npm test: the command exited 0, but 2 of 4 tests failed, in 41 s. Log: /kit/logs/test-1.log');
  });

  it('says FAIL with how many failed of how many', () => {
    assert.equal(headline(run({ end: { kind: 'exited', code: 1 }, parsed: counted(1532, 3) })), 'FAIL npm test: 3 of 1,532 failed in 41 s. Log: /kit/logs/test-1.log');
  });

  it('says how the command ended when no test failed or no counts were printed', () => {
    const exited = { kind: 'exited', code: 2 } as const;
    const signal = { kind: 'signal', signal: 'SIGTERM' } as const;
    assert.equal(headline(run({ end: exited, parsed: counted(10, 0) })), 'FAIL npm test: 0 of 10 tests failed but the command exited 2, in 41 s. Log: /kit/logs/test-1.log');
    assert.equal(headline(run({ end: signal, parsed: counted(10, 0) })), 'FAIL npm test: 0 of 10 tests failed but the command was ended by SIGTERM, in 41 s. Log: /kit/logs/test-1.log');
    assert.equal(headline(run({ end: exited })), 'FAIL npm test in 41 s (exit 2). Log: /kit/logs/test-1.log');
    assert.equal(headline(run({ end: signal })), 'FAIL npm test in 41 s (ended by SIGTERM). Log: /kit/logs/test-1.log');
  });
});

describe('failureBlocks', () => {
  const a = 'not ok a\n  error: one';
  const b = 'not ok b\n  error: two';

  it('prints every failure that fits', () => {
    assert.deepEqual(failureBlocks([a, b], 2, 1000), [a, b]);
  });

  it('stops at the cap and says how many more the log holds, counting those the runner did not print', () => {
    assert.deepEqual(failureBlocks([a, b], 2, a.length + 1), [a, '1 more failure in the log']);
    assert.deepEqual(failureBlocks([a, b], 5, a.length + 1), [a, '4 more failures in the log']);
  });

  it('cuts a first failure longer than the cap at a line, or within its first line', () => {
    assert.deepEqual(failureBlocks([a], 1, 10), ['not ok a\n…']);
    assert.deepEqual(failureBlocks([a, b], 2, 5), ['not …', '1 more failure in the log']);
  });
});

describe('outputTail', () => {
  it(`prints the last ${TAIL_LINES} lines under a line saying how many`, () => {
    const output = `${Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')}\n\n`;
    const [title, tail = ''] = outputTail(output, 4000);
    assert.equal(title, `The output's last ${TAIL_LINES} lines:`);
    assert.ok(tail.startsWith('line 11\n') && tail.endsWith('line 50'));
  });

  it('keeps the end when the lines pass the cap, down to part of the last line', () => {
    assert.deepEqual(outputTail('one\ntwo\nthree', 9), ["The output's last 2 lines:", 'two\nthree']);
    assert.deepEqual(outputTail('a long last line', 5), ["The output's last line:", '…line']);
  });

  it('says when the command printed nothing', () => {
    assert.deepEqual(outputTail('\n', 4000), ['The command printed nothing.']);
  });
});

describe('reportLines', () => {
  it('prints only the headline for a run that passed', () => {
    assert.deepEqual(reportLines(run({ output: 'all good' })), ['PASS npm test in 41 s. Log: /kit/logs/test-1.log']);
  });

  it('prints each failing test, a blank line apart, after the headline', () => {
    const lines = reportLines(run({ end: { kind: 'exited', code: 1 }, parsed: counted(4, 2, ['not ok a', 'not ok b']) }));
    assert.deepEqual(lines, ['FAIL npm test: 2 of 4 failed in 41 s. Log: /kit/logs/test-1.log', 'not ok a', '', 'not ok b']);
  });

  it("prints the output's end when a failed run shows no failing test", () => {
    const lines = reportLines(run({ end: { kind: 'exited', code: 2 }, output: 'src/a.ts(3,1): error TS2304\n' }));
    assert.deepEqual(lines, ['FAIL npm test in 41 s (exit 2). Log: /kit/logs/test-1.log', "The output's last line:", 'src/a.ts(3,1): error TS2304']);
  });

  it('prints the failures a passing command still shows', () => {
    const lines = reportLines(run({ parsed: counted(4, 1, ['not ok a']) }));
    assert.deepEqual(lines.slice(1), ['not ok a']);
  });
});
