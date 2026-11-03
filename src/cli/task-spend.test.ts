import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskUse } from '../budget/task-use.ts';
import { spentSince } from './task-spend.ts';

/** T1's use: alpha and bravo's W per UTC day. */
const USE: TaskUse = {
  task: 'T1',
  sessions: [
    { session: 'alpha', byDay: { '2030-01-06': 5, '2030-01-07': 10, '2030-01-08': 20 }, w: 35 },
    { session: 'bravo', byDay: { '2030-01-07': 4 }, w: 4 },
  ],
  w: 39,
};

describe('spentSince (T649)', () => {
  it('counts all the meter keeps with no base', () => {
    assert.equal(spentSince(USE, null), 39);
  });

  it("counts the base day past its W, summed over sessions, and later days in full", () => {
    assert.equal(spentSince(USE, { day: '2030-01-07', w: 12 }), 2 + 20);
    assert.equal(spentSince(USE, { day: '2030-01-07', w: 30 }), 20, 'a base above the day counts none of it');
  });

  it('counts nothing before the base day, and only later days for a day the meter no longer keeps', () => {
    assert.equal(spentSince(USE, { day: '2030-01-08', w: 0 }), 20);
    assert.equal(spentSince(USE, { day: '2030-01-09', w: 0 }), 0);
    assert.equal(spentSince(USE, { day: '2030-01-01', w: 99 }), 39);
  });
});
