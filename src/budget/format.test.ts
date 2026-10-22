import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import type { PastLimit } from './extra.ts';
import { formatCount, formatEndTime, formatPct, formatUsd, formatW, isBudgetDayEnd, noRoomText } from './format.ts';

describe('budget number formats', () => {
  it('writes shares with two decimals below 1% and one above', () => {
    assert.deepEqual([0, 0.254, 0.5, 1, 9.63, 57, 99.95, -0.4].map(formatPct), ['0.0%', '0.25%', '0.50%', '1.0%', '9.6%', '57.0%', '100.0%', '-0.40%']);
  });

  it("writes why a session past its part is held: the team's use today against its in-day pace", () => {
    assert.equal(noRoomText({ usedPct: 1.4, pacePct: 0.81 }), 'the team has used 1.4% of the week today, at or past its in-day pace of 0.81%');
  });

  it('names the extra-usage pool past the weekly limit, or why nothing gives the team room there', () => {
    const limits: readonly PastLimit[] = ['pool', 'unpriced', 'empty'];
    assert.deepEqual(
      limits.map((pastLimit) => noRoomText({ usedPct: 1.4, pacePct: 0.81, pastLimit })),
      [
        "the team has used 1.4% of the week today, at or past the extra-usage pool's in-day pace of 0.81%",
        'the week is at its weekly limit and the extra-usage pool has no W per dollar yet, which two spent readings past 100% or budget.extraWPerUsd give',
        'the week is at its weekly limit with no extra usage left, which the lead adds with teamrig budget extra --add <usd>',
      ],
    );
  });

  it('writes weighted tokens as plain, k, M or B', () => {
    assert.deepEqual([0, 999.4, 1_000, 849_600, 7_500_000, 261_060_000, 1_200_000_000].map(formatW), ['0', '999', '1k', '850k', '7.50M', '261.06M', '1.20B']);
  });

  it('writes counts with thousands separators', () => {
    assert.deepEqual([0, 49, 2_634, 12_372.4].map(formatCount), ['0', '49', '2,634', '12,372']);
  });

  it('writes dollars with two decimals', () => {
    assert.deepEqual([0, 8, 12.5, 1_234.567].map(formatUsd), ['$0.00', '$8.00', '$12.50', '$1234.57']);
  });

  it("writes an end time on the team's clock, and a UTC midnight as the budget day's end", () => {
    assert.equal(formatEndTime(Date.parse('2030-01-08T18:05:00Z'), TimeZone.UTC), '18:05 UTC');
    assert.equal(formatEndTime(Date.parse('2030-01-09T00:00:00Z'), TimeZone.UTC), '00:00 UTC (the end of the budget day)');
    assert.equal(formatEndTime(Date.parse('2030-01-08T18:05:00Z'), JERUSALEM), '20:05 IST');
    assert.equal(formatEndTime(Date.parse('2030-01-09T00:00:00Z'), JERUSALEM), '02:00 IST (the end of the budget day)');
  });

  it('ends a budget day at a UTC midnight only', () => {
    assert.equal(isBudgetDayEnd(Date.parse('2030-01-09T00:00:00Z')), true);
    assert.equal(isBudgetDayEnd(Date.parse('2030-01-08T18:05:00Z')), false);
  });
});
