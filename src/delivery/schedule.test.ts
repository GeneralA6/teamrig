import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { blackoutStart, queueCutoffReason, queueCutoffSpan, minutesText, parseSpanMinutes, resetBlackoutReason } from './schedule.ts';

const { UTC } = TimeZone;

describe('blackoutStart', () => {
  it('starts the blackout its hours before the reset', () => {
    assert.equal(blackoutStart({ at: Date.parse('2030-01-09T01:00:00Z'), source: 'status line' }, 4), Date.parse('2030-01-08T21:00:00Z'));
  });
});

describe('resetBlackoutReason', () => {
  const reset = { at: Date.parse('2030-01-09T01:00:00Z'), source: 'status line' };

  it('lets a deploy start before the blackout and from the reset on', () => {
    assert.equal(resetBlackoutReason(Date.parse('2030-01-08T20:59:59Z'), reset, 4, UTC), undefined);
    assert.equal(resetBlackoutReason(Date.parse('2030-01-09T01:00:00Z'), reset, 4, UTC), undefined);
  });

  it('refuses a deploy from the hours before the reset until it, naming the window and the reset source', () => {
    assert.equal(
      resetBlackoutReason(Date.parse('2030-01-08T21:00:00Z'), reset, 4, UTC),
      'deploy blackout before the weekly token reset: no deploy from Tue 01-08 21:00 UTC until Wed 01-09 01:00 UTC (reset from the status line)',
    );
    assert.notEqual(resetBlackoutReason(Date.parse('2030-01-09T00:59:59Z'), reset, 4, UTC), undefined);
  });

  it("names the window on the team's clock", () => {
    assert.equal(
      resetBlackoutReason(Date.parse('2030-01-08T21:00:00Z'), reset, 4, JERUSALEM),
      'deploy blackout before the weekly token reset: no deploy from Tue 01-08 23:00 IST until Wed 01-09 03:00 IST (reset from the status line)',
    );
  });

  it('has no blackout with no hours set or no known reset', () => {
    const now = Date.parse('2030-01-08T23:00:00Z');
    assert.equal(resetBlackoutReason(now, reset, undefined, UTC), undefined);
    assert.equal(resetBlackoutReason(now, undefined, 4, UTC), undefined);
  });
});

describe('queueCutoffSpan', () => {
  it('runs from the cutoff to the end of the UTC day', () => {
    assert.deepEqual(queueCutoffSpan(Date.parse('2030-01-08T09:00:00Z'), '22:30'), { from: Date.parse('2030-01-08T22:30:00Z'), to: Date.parse('2030-01-09T00:00:00Z') });
    assert.deepEqual(queueCutoffSpan(Date.parse('2030-01-08T23:00:00Z'), '22:30'), { from: Date.parse('2030-01-08T22:30:00Z'), to: Date.parse('2030-01-09T00:00:00Z') });
  });

  it('has no span with no cutoff set', () => {
    assert.equal(queueCutoffSpan(Date.parse('2030-01-08T23:00:00Z'), undefined), undefined);
  });
});

describe('queueCutoffReason', () => {
  it('lets every step start when no cutoff is set', () => {
    assert.equal(queueCutoffReason(Date.parse('2030-01-08T23:59:00Z'), undefined, UTC), undefined);
  });

  it('lets a step start before the cutoff and from midnight UTC on', () => {
    assert.equal(queueCutoffReason(Date.parse('2030-01-08T22:29:59Z'), '22:30', UTC), undefined);
    assert.equal(queueCutoffReason(Date.parse('2030-01-09T00:00:00Z'), '22:30', UTC), undefined);
  });

  it('refuses from the cutoff to midnight UTC, naming the span and the time', () => {
    assert.equal(queueCutoffReason(Date.parse('2030-01-08T22:30:00Z'), '22:30', UTC), 'queue cutoff 22:30-00:00 UTC (now 22:30 UTC)');
    assert.equal(queueCutoffReason(Date.parse('2030-01-08T23:59:59Z'), '22:30', UTC), 'queue cutoff 22:30-00:00 UTC (now 23:59 UTC)');
  });

  it("names the span and the time on the team's clock", () => {
    assert.equal(queueCutoffReason(Date.parse('2030-01-08T22:45:00Z'), '22:30', JERUSALEM), 'queue cutoff 00:30-02:00 IST (now 00:45 IST)');
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
