import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { heavyCutoffReason, minutesText, parseSpanMinutes, resetBlackoutReason } from './schedule.ts';

describe('resetBlackoutReason', () => {
  const reset = { at: Date.parse('2030-01-09T01:00:00Z'), source: 'status line' };

  it('lets a deploy start before the blackout and from the reset on', () => {
    assert.equal(resetBlackoutReason(Date.parse('2030-01-08T20:59:59Z'), reset, 4), undefined);
    assert.equal(resetBlackoutReason(Date.parse('2030-01-09T01:00:00Z'), reset, 4), undefined);
  });

  it('refuses a deploy from the hours before the reset until it, naming the window and the reset source', () => {
    assert.equal(
      resetBlackoutReason(Date.parse('2030-01-08T21:00:00Z'), reset, 4),
      'deploy blackout before the weekly token reset: no deploy from 2030-01-08 21:00 until 2030-01-09 01:00 UTC (reset from the status line)',
    );
    assert.notEqual(resetBlackoutReason(Date.parse('2030-01-09T00:59:59Z'), reset, 4), undefined);
  });

  it('has no blackout with no hours set or no known reset', () => {
    const now = Date.parse('2030-01-08T23:00:00Z');
    assert.equal(resetBlackoutReason(now, reset, undefined), undefined);
    assert.equal(resetBlackoutReason(now, undefined, 4), undefined);
  });
});

describe('heavyCutoffReason', () => {
  it('lets every step start when no cutoff is set', () => {
    assert.equal(heavyCutoffReason(Date.parse('2030-01-08T23:59:00Z'), undefined), undefined);
  });

  it('lets a step start before the cutoff and from midnight UTC on', () => {
    assert.equal(heavyCutoffReason(Date.parse('2030-01-08T22:29:59Z'), '22:30'), undefined);
    assert.equal(heavyCutoffReason(Date.parse('2030-01-09T00:00:00Z'), '22:30'), undefined);
  });

  it('refuses from the cutoff to midnight UTC, naming the time', () => {
    assert.equal(heavyCutoffReason(Date.parse('2030-01-08T22:30:00Z'), '22:30'), 'nothing heavy after 22:30 UTC (now 2030-01-08 22:30)');
    assert.equal(heavyCutoffReason(Date.parse('2030-01-08T23:59:59Z'), '22:30'), 'nothing heavy after 22:30 UTC (now 2030-01-08 23:59)');
  });
});

describe('minutesText', () => {
  it('writes minutes under an hour as minutes, longer spans as hours and two-digit minutes', () => {
    assert.deepEqual([1, 45, 60, 65, 140].map(minutesText), ['1m', '45m', '1h00m', '1h05m', '2h20m']);
  });
});

describe('parseSpanMinutes', () => {
  it('reads minutes, hours, and both, and reads back what minutesText writes', () => {
    assert.deepEqual(['45m', '2h', '1h30m', '1h05m', ' 90m '].map(parseSpanMinutes), [45, 120, 90, 65, 90]);
    assert.deepEqual([1, 45, 60, 65, 140].map((minutes) => parseSpanMinutes(minutesText(minutes))), [1, 45, 60, 65, 140]);
  });

  it('reads no other text, and no span of none', () => {
    const odd = ['', '0m', '0h0m', '30', '90s', '1.5h', 'm', '1h30', '-5m', '30m2h'];
    assert.deepEqual(odd.map(parseSpanMinutes), odd.map(() => undefined));
  });
});
