import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NOT_STARTED_EXIT } from '../delivery/recorded-step.ts';
import { TIMED_OUT_EXIT } from '../delivery/steps.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { REVIEW_CHECK_FLAGGED } from '../push-guard/review-gate.ts';
import { checkExitCode, REVIEW_BASE_ENV, REVIEW_FINDINGS_LIMITS, runReviewCheck, type ReviewCheck } from './review-check.ts';

const ARGV = ['node', 'review.js'];

function check(shown: string[], overrides: Partial<ReviewCheck> = {}): ReviewCheck {
  return {
    argv: ARGV,
    cwd: '/repo',
    base: 'abc123',
    env: { PATH: '/bin' },
    timeoutMs: 60_000,
    redact: (line) => line.replace(/tok_\w+/g, 'tok_***'),
    onLine: (line) => shown.push(line),
    ...overrides,
  };
}

describe('runReviewCheck', () => {
  it('runs the check against the base it names, and reads exit 0 as clean', async () => {
    const hooks = new FakeHooks().answer(ARGV, { lines: ['looked at 3 files'] });
    const shown: string[] = [];
    assert.deepEqual(await runReviewCheck(hooks, check(shown)), { kind: 'clean' });
    assert.equal(hooks.ran[0]?.env[REVIEW_BASE_ENV], 'abc123');
    assert.equal(hooks.ran[0]?.env['PATH'], '/bin');
    assert.equal(hooks.ran[0]?.cwd, '/repo');
    assert.deepEqual(shown, ['looked at 3 files']);
  });

  it('reads exit 3 as flagged, keeping what it printed with its secrets masked', async () => {
    const hooks = new FakeHooks().answer(ARGV, { lines: ['[{"rule":"token","line":"tok_live9"}]'], end: 3 });
    const shown: string[] = [];
    assert.deepEqual(await runReviewCheck(hooks, check(shown)), { kind: 'flagged', findings: '[{"rule":"token","line":"tok_***"}]' });
    assert.deepEqual(shown, ['[{"rule":"token","line":"tok_***"}]']);
  });

  it('bounds the findings it keeps, saying how many lines it left out', async () => {
    const { maxLines, maxLineLength } = REVIEW_FINDINGS_LIMITS;
    const lines = Array.from({ length: maxLines + 2 }, () => 'x'.repeat(maxLineLength + 10));
    const outcome = await runReviewCheck(new FakeHooks().answer(ARGV, { lines, end: 3 }), check([]));
    assert.equal(outcome.kind, 'flagged');
    const kept = outcome.kind === 'flagged' ? outcome.findings.split('\n') : [];
    assert.equal(kept.length, maxLines + 1);
    assert.equal(kept[0]?.length, maxLineLength);
    assert.equal(kept.at(-1), '… 2 more line(s) in the merge output');
  });

  it('reads any other end as broken, saying how it ended', async () => {
    assert.deepEqual(await runReviewCheck(new FakeHooks().answer(ARGV, { end: 1 }), check([])), { kind: 'broken', detail: 'exited 1', exitCode: 1 });
    assert.deepEqual(await runReviewCheck(new FakeHooks().answer(ARGV, { end: { kind: 'timedOut' } }), check([])), {
      kind: 'broken',
      detail: 'was killed at its time limit',
      exitCode: TIMED_OUT_EXIT,
    });
    assert.deepEqual(await runReviewCheck(new FakeHooks().answer(ARGV, { end: { kind: 'notStarted', error: 'ENOENT' } }), check([])), {
      kind: 'broken',
      detail: 'could not start (ENOENT)',
      exitCode: NOT_STARTED_EXIT,
    });
  });
});

describe('checkExitCode', () => {
  it('records 0 for a clean check, the flag code for a flagged one, and how a broken one ended', () => {
    assert.equal(checkExitCode({ kind: 'clean' }), 0);
    assert.equal(checkExitCode({ kind: 'flagged', findings: 'x' }), REVIEW_CHECK_FLAGGED);
    assert.equal(checkExitCode({ kind: 'broken', detail: 'was killed at its time limit', exitCode: TIMED_OUT_EXIT }), TIMED_OUT_EXIT);
  });
});
