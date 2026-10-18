import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { heavyCutoffReason, minutesText } from './schedule.ts';

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
