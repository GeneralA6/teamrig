import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatCount, formatEndTime, formatPct, formatTimeOfDay, formatW, formatWeekdayMinute } from './format.ts';

describe('budget number formats', () => {
  it('writes shares with two decimals below 1% and one above', () => {
    assert.deepEqual([0, 0.254, 0.5, 1, 9.63, 57, 99.95, -0.4].map(formatPct), ['0.0%', '0.25%', '0.50%', '1.0%', '9.6%', '57.0%', '100.0%', '-0.40%']);
  });

  it('writes weighted tokens as plain, k, M or B', () => {
    assert.deepEqual([0, 999.4, 1_000, 849_600, 7_500_000, 261_060_000, 1_200_000_000].map(formatW), ['0', '999', '1k', '850k', '7.50M', '261.06M', '1.20B']);
  });

  it('writes counts with thousands separators', () => {
    assert.deepEqual([0, 49, 2_634, 12_372.4].map(formatCount), ['0', '49', '2,634', '12,372']);
  });

  it('writes a time of day, and an end time at midnight as the end of the day', () => {
    assert.equal(formatTimeOfDay(Date.parse('2030-01-08T18:05:00Z')), '18:05 UTC');
    assert.equal(formatTimeOfDay(Date.parse('2030-01-09T00:00:00Z')), '00:00 UTC');
    assert.equal(formatEndTime(Date.parse('2030-01-08T18:05:00Z')), '18:05 UTC');
    assert.equal(formatEndTime(Date.parse('2030-01-09T00:00:00Z')), 'the end of the day (UTC)');
  });

  it('writes an instant with its weekday', () => {
    assert.equal(formatWeekdayMinute(Date.parse('2026-10-21T01:00:00Z')), 'Wed 10-21 01:00 UTC');
    assert.equal(formatWeekdayMinute(Date.parse('2030-01-06T23:59:00Z')), 'Sun 01-06 23:59 UTC');
  });
});
