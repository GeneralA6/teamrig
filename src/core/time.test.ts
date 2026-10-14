import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatUtcDay, formatUtcMinute, parseUtcDeadline } from './time.ts';

describe('parseUtcDeadline', () => {
  it('reads a bare day as the end of that day in UTC', () => {
    assert.equal(parseUtcDeadline('2030-01-31')?.toISOString(), '2030-01-31T23:59:59.999Z');
  });

  it('reads a day with a time as that minute in UTC', () => {
    assert.equal(parseUtcDeadline('2030-01-31 08:05')?.toISOString(), '2030-01-31T08:05:00.000Z');
    assert.equal(parseUtcDeadline('2030-01-31T08:05')?.toISOString(), '2030-01-31T08:05:00.000Z');
  });

  it('rejects malformed and impossible dates', () => {
    for (const text of ['2030-1-31', '2030-02-30', '2030-13-01', '2030-01-31 24:00', '2030-01-31 10:60', 'soon']) {
      assert.equal(parseUtcDeadline(text), undefined, text);
    }
  });
});

describe('formatUtc', () => {
  it('formats minutes and days in UTC', () => {
    const date = new Date('2030-05-06T07:08:09Z');
    assert.equal(formatUtcMinute(date), '2030-05-06 07:08');
    assert.equal(formatUtcDay(date), '2030-05-06');
  });
});
