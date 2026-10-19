import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HIRING } from '../config/defaults.ts';
import { testTask } from '../testing/task.ts';
import { formatHireFlag, hireFlags, type HireCheckInput, type HireFlag } from './due.ts';
import type { HireRecord } from './log.ts';

const HIRED_AT = Date.parse('2030-01-08T10:00:00Z');
const HOUR_MS = 3_600_000;
const RETIRE = 'retire it (teamrig retire helper)';

function hire(session: string, reviewBy = '2030-01-15'): HireRecord {
  return { kind: 'hire', session, scope: 'x', reason: 'y', reviewBy, by: 'lead', at: HIRED_AT };
}

function input(overrides: Partial<HireCheckInput> = {}): HireCheckInput {
  return {
    hires: [hire('helper')],
    tasks: [],
    config: { sessions: ['lead', 'helper'], hiring: DEFAULT_HIRING },
    burstsOver: new Set(),
    now: new Date(HIRED_AT + 5 * HOUR_MS),
    ...overrides,
  };
}

describe('hireFlags', () => {
  it('flags a hired session with no open task for hiring.idleHours, counting from its hire', () => {
    assert.deepEqual(hireFlags(input()), [{ kind: 'RETIRE-DUE', session: 'helper', detail: 'no open task for 5 h, hiring.idleHours 4', action: RETIRE }]);
    assert.deepEqual(hireFlags(input({ now: new Date(HIRED_AT + 3 * HOUR_MS) })), []);
  });

  it('counts from its newest closed task, and never flags one with an open task', () => {
    const done = testTask({ owner: 'helper', status: 'done', statusAt: new Date(HIRED_AT + 2 * HOUR_MS).toISOString() });
    assert.deepEqual(hireFlags(input({ tasks: [done] })), []);
    assert.equal(hireFlags(input({ tasks: [done], now: new Date(HIRED_AT + 6 * HOUR_MS) }))[0]?.detail, 'no open task for 4 h, hiring.idleHours 4');
    const waiting = testTask({ id: 'T2', owner: 'helper', status: 'waiting' });
    assert.deepEqual(hireFlags(input({ tasks: [done, waiting], now: new Date(HIRED_AT + 99 * HOUR_MS) })), []);
    assert.equal(hireFlags(input({ tasks: [testTask({ status: 'open' })] })).length, 1, "another session's task does not count");
  });

  it('keeps an idle hire a SCALE-OUT gives a slice, but not one whose burst is over', () => {
    assert.deepEqual(hireFlags(input(), new Set(['helper'])), []);
    const burstHire: HireRecord = { ...hire('helper'), burst: HIRED_AT };
    assert.equal(hireFlags(input({ hires: [burstHire], burstsOver: new Set([HIRED_AT]) }), new Set(['helper'])).length, 1);
  });

  it('flags a review day that has passed, and skips hires no longer on the team', () => {
    const late = input({ hires: [hire('helper', '2030-01-07'), hire('gone')], tasks: [testTask({ owner: 'helper' })] });
    const action = 'decide whether its job goes on, else retire it (teamrig retire helper)';
    assert.deepEqual(hireFlags(late), [{ kind: 'REVIEW-DUE', session: 'helper', detail: 'review day 2030-01-07 passed', action }]);
    assert.deepEqual(hireFlags(input({ hires: [hire('helper', '2030-01-08')], tasks: [testTask({ owner: 'helper' })] })), []);
  });

  it('flags a burst hire RETIRE-DUE once its burst is over, even with an open task', () => {
    const burstHire: HireRecord = { ...hire('helper'), burst: HIRED_AT };
    const busy = { hires: [burstHire], tasks: [testTask({ owner: 'helper' })] };
    assert.deepEqual(hireFlags(input(busy)), []);
    assert.deepEqual(hireFlags(input({ ...busy, burstsOver: new Set([HIRED_AT - 1]) })), []);
    assert.deepEqual(hireFlags(input({ ...busy, burstsOver: new Set([HIRED_AT]) })), [{ kind: 'RETIRE-DUE', session: 'helper', detail: 'the burst it was hired for is over', action: RETIRE }]);
  });
});

describe('formatHireFlag', () => {
  it('names the flag, its detail, the session and what clears it', () => {
    const flag: HireFlag = { kind: 'RETIRE-DUE', session: 'helper', detail: 'no open task for 5 h, hiring.idleHours 4', action: RETIRE };
    assert.equal(formatHireFlag(flag), 'HIRE RETIRE-DUE (no open task for 5 h, hiring.idleHours 4) helper: retire it (teamrig retire helper)');
  });
});
