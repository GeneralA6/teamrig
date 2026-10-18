import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatUtcDay, formatUtcMinute, parseUtcDay, parseUtcDeadline, parseUtcInstant, shortUtc } from './time.ts';

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

describe('parseUtcDay', () => {
  it('reads a bare day as its first instant and refuses anything else', () => {
    assert.equal(parseUtcDay('2030-01-07')?.toISOString(), '2030-01-07T00:00:00.000Z');
    assert.equal(parseUtcDay('2030-01-07 10:00'), undefined);
    assert.equal(parseUtcDay('2030-02-30'), undefined);
  });
});

describe('shortUtc', () => {
  it('drops the year', () => {
    assert.equal(shortUtc('2030-01-09 12:00'), '01-09 12:00');
    assert.equal(shortUtc('2030-01-09'), '01-09');
  });
});

describe('parseUtcInstant', () => {
  const NOW = Date.parse('2030-01-08T15:20:00Z');

  it('reads a clock time as today, a day as its start, a minute and a zoned ISO time, all in UTC', () => {
    assert.deepEqual(
      ['09:05', '2030-01-07', '2030-01-07 23:45', '2030-01-07T23:45', '2030-01-07T23:45:30.500Z', '2030-01-08T01:00+02:00'].map((text) => parseUtcInstant(text, NOW)?.toISOString()),
      ['2030-01-08T09:05:00.000Z', '2030-01-07T00:00:00.000Z', '2030-01-07T23:45:00.000Z', '2030-01-07T23:45:00.000Z', '2030-01-07T23:45:30.500Z', '2030-01-07T23:00:00.000Z'],
    );
  });

  it('refuses an impossible time, an ISO time with seconds but no zone, and anything else', () => {
    assert.deepEqual(
      ['24:00', '9:05', '2030-02-30', '2030-01-07 23:60', '2030-01-07T23:45:30', 'now', ''].map((text) => parseUtcInstant(text, NOW)),
      [undefined, undefined, undefined, undefined, undefined, undefined, undefined],
    );
  });
});
