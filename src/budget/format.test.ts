import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { formatClockSpan, formatCount, formatEndTime, formatPct, formatW } from './format.ts';

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

  it("writes an end time on the team's clock, and a UTC midnight as the budget day's end", () => {
    assert.equal(formatEndTime(Date.parse('2030-01-08T18:05:00Z'), TimeZone.UTC), '18:05 UTC');
    assert.equal(formatEndTime(Date.parse('2030-01-09T00:00:00Z'), TimeZone.UTC), '00:00 UTC (the end of the budget day)');
    assert.equal(formatEndTime(Date.parse('2030-01-08T18:05:00Z'), JERUSALEM), '20:05 IST');
    assert.equal(formatEndTime(Date.parse('2030-01-09T00:00:00Z'), JERUSALEM), '02:00 IST (the end of the budget day)');
  });

  it("writes a stretch of the day on the team's clock, with both zones across a change of clocks", () => {
    assert.equal(formatClockSpan(Date.parse('2026-10-15T22:00:00Z'), Date.parse('2026-10-16T06:00:00Z'), TimeZone.UTC), '22:00-06:00 UTC');
    assert.equal(formatClockSpan(Date.parse('2026-10-15T22:00:00Z'), Date.parse('2026-10-16T06:00:00Z'), JERUSALEM), '01:00-09:00 IDT');
    assert.equal(formatClockSpan(Date.parse('2026-10-24T22:00:00Z'), Date.parse('2026-10-25T06:00:00Z'), JERUSALEM), '01:00 IDT-08:00 IST');
  });

  it('writes an instant with its weekday', () => {
  });
});
