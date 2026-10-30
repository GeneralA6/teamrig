import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatHireFlag, hireFlags, type HireCheckInput, type HireFlag } from './due.ts';
import type { HireRecord } from './record.ts';

const HIRED_AT = Date.parse('2030-01-08T10:00:00Z');
const HOUR_MS = 3_600_000;
const RETIRE = 'retire it (teamrig retire helper)';
const BURST_OVER = 'the burst it was hired for is over';

function hire(session: string, reviewBy = '2030-01-15'): HireRecord {
  return { kind: 'hire', session, scope: 'x', reason: 'y', reviewBy, by: 'lead', at: HIRED_AT };
}

function input(overrides: Partial<HireCheckInput> = {}): HireCheckInput {
  return {
    hires: [hire('helper')],
    config: { sessions: ['lead', 'helper'] },
    burstsOver: new Set(),
    now: new Date(HIRED_AT + 5 * HOUR_MS),
    ...overrides,
  };
}

describe('hireFlags', () => {
  it('never flags a hire RETIRE-DUE for being idle: the idle pass deactivates it, the team keeps it', () => {
    assert.deepEqual(hireFlags(input({ now: new Date(HIRED_AT + 6 * 24 * HOUR_MS) })), []);
  });

  it('flags a review day that has passed, and skips hires no longer on the team', () => {
    const late = input({ hires: [hire('helper', '2030-01-07'), hire('gone', '2030-01-07')] });
    const action = 'decide whether its job goes on, else retire it (teamrig retire helper)';
    assert.deepEqual(hireFlags(late), [{ kind: 'REVIEW-DUE', session: 'helper', detail: 'review day 2030-01-07 passed', action }]);
    assert.deepEqual(hireFlags(input({ hires: [hire('helper', '2030-01-08')] })), []);
  });

  it('flags a burst hire RETIRE-DUE once its burst is over, before its REVIEW-DUE', () => {
    const burstHire: HireRecord = { ...hire('helper'), burst: HIRED_AT };
    assert.deepEqual(hireFlags(input({ hires: [burstHire] })), []);
    assert.deepEqual(hireFlags(input({ hires: [burstHire], burstsOver: new Set([HIRED_AT - 1]) })), []);
    assert.deepEqual(hireFlags(input({ hires: [burstHire], burstsOver: new Set([HIRED_AT]) })), [{ kind: 'RETIRE-DUE', session: 'helper', detail: BURST_OVER, action: RETIRE }]);
    const lateBurst: HireRecord = { ...burstHire, reviewBy: '2030-01-07' };
    const kinds = hireFlags(input({ hires: [lateBurst], burstsOver: new Set([HIRED_AT]) })).map((flag) => flag.kind);
    assert.deepEqual(kinds, ['RETIRE-DUE', 'REVIEW-DUE']);
  });
});

describe('formatHireFlag', () => {
  it('names the flag, its detail, the session and what clears it', () => {
    const flag: HireFlag = { kind: 'RETIRE-DUE', session: 'helper', detail: BURST_OVER, action: RETIRE };
    assert.equal(formatHireFlag(flag), 'HIRE RETIRE-DUE (the burst it was hired for is over) helper: retire it (teamrig retire helper)');
  });
});
