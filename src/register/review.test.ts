import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REGISTER } from '../config/defaults.ts';
import { testTask } from '../testing/task.ts';
import type { ItemType } from './events.ts';
import {
  asksReview,
  isCritical,
  missedTaskIds,
  missingParts,
  parseReview,
  partFlags,
  requiredParts,
  reviewGap,
  reviewGapText,
  reviewLines,
  reviewPartNames,
  reviewProblem,
  reviewTexts,
  type ProblemReview,
} from './review.ts';

const FULL = {
  cause: 'the parser skipped blank rows',
  how: 'a refactor dropped the guard last week',
  prevent: 'a spec now feeds a blank row',
  missedTest: 'no spec fed blank rows before T124',
  missedMonitor: 'no alert counts skipped rows yet',
  missedLog: 'the skip logged nothing at all',
} satisfies ProblemReview;

describe('the problem review', () => {
  it('asks every part of a problem but hardening, which a critical problem gives too', () => {
    assert.deepEqual(requiredParts(false), ['cause', 'how', 'prevent', 'missedTest', 'missedMonitor', 'missedLog']);
    assert.deepEqual(requiredParts(true), ['cause', 'how', 'prevent', 'harden', 'missedTest', 'missedMonitor', 'missedLog']);
  });

  it('names the parts still missing, in print order', () => {
    assert.deepEqual(missingParts(FULL, false), []);
    assert.deepEqual(missingParts(FULL, true), ['harden']);
    assert.deepEqual(missingParts({ how: FULL.how }, false), ['cause', 'prevent', 'missedTest', 'missedMonitor', 'missedLog']);
  });

  it('names the flags that give the parts as one phrase', () => {
    assert.equal(partFlags([]), '');
    assert.equal(partFlags(['harden']), '--harden');
    assert.equal(partFlags(['cause', 'missedTest']), '--cause and --missed-test');
    assert.equal(partFlags(['cause', 'how', 'missedLog']), '--cause, --how and --missed-log');
  });

  it('refuses a part with fewer than three plain words besides task ids', () => {
    assert.equal(reviewProblem(FULL), undefined);
    assert.equal(reviewProblem({}), undefined);
    assert.match(reviewProblem({ missedTest: 'T124' }) ?? '', /--missed-test says "T124": give at least 3 plain words/);
    assert.match(reviewProblem({ cause: FULL.cause, how: 'a refactor' }) ?? '', /^--how says "a refactor"/);
  });

  it('collects the task ids only the missed parts name, each once', () => {
    assert.deepEqual(missedTaskIds({ ...FULL, cause: 'T9 broke the parser', missedLog: 'T124 adds the skip log line' }), ['T124']);
    assert.deepEqual(missedTaskIds({ cause: 'T9 broke the parser' }), []);
  });

  it('pairs each part given with its flag, and lists the flag names a status line gave', () => {
    assert.deepEqual(reviewTexts({ missedLog: FULL.missedLog, cause: FULL.cause }), [
      ['--cause', FULL.cause],
      ['--missed-log', FULL.missedLog],
    ]);
    assert.equal(reviewPartNames({ missedLog: FULL.missedLog, cause: FULL.cause }), 'cause,missed-log');
    assert.equal(reviewPartNames({}), '');
  });

  it('prints a labelled line per part given, in order', () => {
    assert.deepEqual(reviewLines({ prevent: FULL.prevent, cause: FULL.cause }, '  '), [`  cause: ${FULL.cause}`, `  prevented by: ${FULL.prevent}`]);
    assert.deepEqual(reviewLines({}, '  '), []);
  });

  it('reads a stored review, skipping parts it does not know and absent ones', () => {
    assert.equal(parseReview(undefined), undefined);
    assert.equal(parseReview(null), undefined);
    assert.deepEqual(parseReview({ cause: FULL.cause, how: null, rootedIn: 'a newer part' }), { cause: FULL.cause });
    assert.deepEqual(parseReview(FULL), FULL);
  });

  it('refuses a stored review that is not an object of texts', () => {
    assert.equal(parseReview('the cause'), 'review is not an object');
    assert.equal(parseReview(['the cause']), 'review is not an object');
    assert.equal(parseReview({ cause: 3 }), 'review cause is not text');
  });
});

describe('the review gate', () => {
  const CONFIG = DEFAULT_REGISTER.review;
  const PROBLEM = testTask({ type: 'bug', owner: 'alpha' });

  it('asks a review only of a bug, never of a task or an untyped item', () => {
    const types: (ItemType | null)[] = [null, 'task', 'bug'];
    assert.deepEqual(
      types.map((type) => asksReview({ type })),
      [false, false, true],
    );
  });

  it('counts a bug critical when marked so, or when a critical owner owns it, never a task', () => {
    assert.equal(isCritical({ type: 'bug', critical: true, owner: 'alpha' }, []), true);
    assert.equal(isCritical({ type: 'bug', critical: false, owner: 'alpha' }, ['alpha']), true);
    assert.equal(isCritical({ type: 'bug', critical: false, owner: 'alpha' }, ['bravo']), false);
    assert.equal(isCritical({ type: 'task', critical: false, owner: 'alpha' }, ['alpha']), false);
    assert.equal(isCritical({ type: null, critical: true, owner: 'alpha' }, []), false, 'a mark on a type without a review counts for nothing');
  });

  it('names the parts a bug lacks at a required status, counting those it has and those given now', () => {
    assert.deepEqual(reviewGap(PROBLEM, 'verifying', {}, CONFIG), ['cause', 'how', 'prevent', 'missedTest', 'missedMonitor', 'missedLog']);
    const partly = testTask({ ...PROBLEM, review: { cause: FULL.cause } });
    assert.deepEqual(reviewGap(partly, 'done', { how: FULL.how, missedLog: FULL.missedLog }, CONFIG), ['prevent', 'missedTest', 'missedMonitor']);
    assert.deepEqual(reviewGap(PROBLEM, 'done', FULL, CONFIG), []);
    assert.deepEqual(reviewGap(PROBLEM, 'done', FULL, { ...CONFIG, criticalOwners: ['alpha'] }), ['harden']);
  });

  it('asks nothing of a task, at a status the team leaves out, or with the review off', () => {
    assert.deepEqual(reviewGap(testTask({ type: 'task' }), 'done', {}, CONFIG), []);
    assert.deepEqual(reviewGap(PROBLEM, 'in-progress', {}, CONFIG), []);
    assert.deepEqual(reviewGap(PROBLEM, 'dropped', {}, CONFIG), []);
    assert.deepEqual(reviewGap(PROBLEM, 'verifying', {}, { ...CONFIG, requireOn: ['done'] }), []);
    assert.deepEqual(reviewGap(PROBLEM, 'done', {}, { ...CONFIG, mode: 'off' }), []);
    assert.equal(reviewGap(PROBLEM, 'done', {}, { ...CONFIG, mode: 'warn' }).length, 6, 'warn still names the gap, for the CLI to print');
  });

  it('words the gap as one line naming the flags that close it', () => {
    assert.equal(
      reviewGapText({ id: 'T7', type: 'bug' }, 'done', ['harden']),
      'T7 is a bug: done needs its review, --harden (how it happened, what stops it and how it was missed; teamrig help set)',
    );
  });
});
