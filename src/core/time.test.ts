import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addUtcDays, formatUtcDay, formatUtcHour, formatUtcMinute, isMinuteInSpan, parseDayStart, parseDeadline, parseTypedInstant, parseUtcDay, parseUtcDeadline, showStored, storedDeadline, typedDeadline, typedTimeHint, utcMinuteOf } from './time.ts';
import { TimeZone } from './zone.ts';
import { JERUSALEM } from '../testing/zone.ts';

describe('utcMinuteOf', () => {
  it('reads HH:MM as minutes since midnight, and nothing else', () => {
    assert.deepEqual(
      ['00:00', '06:30', '23:59', '24:00', '06:60', '6:30', '06:30 ', ''].map(utcMinuteOf),
      [0, 390, 1439, undefined, undefined, undefined, undefined, undefined],
    );
  });
});

describe('isMinuteInSpan', () => {
  it('takes the start in and the end out, across midnight too, and an empty span never', () => {
    assert.deepEqual([539, 540, 659, 660].map((minute) => isMinuteInSpan(minute, 540, 660)), [false, true, true, false]);
    assert.deepEqual([1319, 1320, 0, 359, 360].map((minute) => isMinuteInSpan(minute, 1320, 360)), [false, true, true, true, false]);
    assert.equal(isMinuteInSpan(540, 540, 540), false);
  });
});

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
  it('formats minutes, hours and days in UTC', () => {
    const date = new Date('2030-05-06T07:08:09Z');
    assert.equal(formatUtcMinute(date), '2030-05-06 07:08');
    assert.equal(formatUtcHour(date), '2030-05-06T07');
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

describe('addUtcDays', () => {
  it('steps a bare day across month and year ends, both ways', () => {
    assert.equal(addUtcDays('2030-01-07', 7), '2030-01-14');
    assert.equal(addUtcDays('2030-01-31', 1), '2030-02-01');
    assert.equal(addUtcDays('2030-01-01', -1), '2029-12-31');
    assert.equal(addUtcDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addUtcDays('2030-03-30', 0), '2030-03-30');
  });

  it('gives nothing for text that is no bare day', () => {
    assert.equal(addUtcDays('2030-02-30', 1), undefined);
    assert.equal(addUtcDays('2030-01-07 10:00', 1), undefined);
    assert.equal(addUtcDays('yesterday', -1), undefined);
  });
});

describe('in the team zone', () => {

  const NOW = Date.parse('2026-10-19T21:30:00Z');

  it("reads a stored bare day as that day of the team's zone, and a stored minute as UTC", () => {
    assert.deepEqual(
      [parseDayStart('2026-10-20', JERUSALEM), parseDeadline('2026-10-20', JERUSALEM), parseDeadline('2026-10-20 06:00', JERUSALEM)].map((date) => date?.toISOString()),
      ['2026-10-19T21:00:00.000Z', '2026-10-20T20:59:59.999Z', '2026-10-20T06:00:00.000Z'],
    );
    assert.deepEqual([parseDeadline('2026-10-25', JERUSALEM)?.toISOString(), parseDeadline('2026-02-30', JERUSALEM), parseDayStart('2026-10-20 06:00', JERUSALEM)], ['2026-10-25T21:59:59.999Z', undefined, undefined]);
  });

  it('shows a stored day as it is and a stored minute in the zone, without the year', () => {
    assert.deepEqual(['2026-10-22', '2026-10-20 06:00', 'soon'].map((text) => showStored(text, JERUSALEM)), ['10-22', '10-20 09:00 IDT', 'soon']);
  });

  it("reads a typed time on the zone's clock, today there, unless marked UTC", () => {
    assert.deepEqual(
      ['09:00', '09:00 IDT', '09:00 utc', '2026-10-25 09:00 IST', '2026-10-25T09:00', '2026-10-21', '2026-10-21T09:00+02:00'].map((text) => parseTypedInstant(text, NOW, JERUSALEM)?.toISOString()),
      ['2026-10-20T06:00:00.000Z', '2026-10-20T06:00:00.000Z', '2026-10-20T09:00:00.000Z', '2026-10-25T07:00:00.000Z', '2026-10-25T07:00:00.000Z', '2026-10-20T21:00:00.000Z', '2026-10-21T07:00:00.000Z'],
    );
  });

  it("refuses a mark of another zone or another season, and anything it cannot read", () => {
    assert.deepEqual(
      ['09:00 IST', '09:00 EST', '2026-10-25 09:00 IDT', '24:00', '2026-02-30 09:00', '9:00', 'now'].map((text) => parseTypedInstant(text, NOW, JERUSALEM)),
      [undefined, undefined, undefined, undefined, undefined, undefined, undefined],
    );
  });

  it('stores a typed day as it is and a typed time as its UTC minute', () => {
    assert.deepEqual(
      ['2026-10-22', '2026-10-22 09:00', '2026-10-22 09:00 UTC', '2026-02-30', 'Friday'].map((text) => storedDeadline(text, NOW, JERUSALEM)),
      ['2026-10-22', '2026-10-22 06:00', '2026-10-22 09:00', undefined, undefined],
    );
  });

  it('says how to type a time, with the zone', () => {
    assert.equal(typedTimeHint(JERUSALEM, NOW), 'HH:MM or YYYY-MM-DD HH:MM in Asia/Jerusalem (IDT), or marked UTC');
    assert.equal(typedTimeHint(TimeZone.UTC, NOW), 'HH:MM or YYYY-MM-DD HH:MM in UTC', 'a UTC clock needs no mark');
  });
});

describe('typedDeadline', () => {
  it('reads a typed deadline as the instant its stored form ends at', () => {
    const now = Date.parse('2030-01-08T12:00:00.000Z');
    assert.equal(typedDeadline('2030-01-09', now, JERUSALEM)?.toISOString(), '2030-01-09T21:59:59.999Z', 'a bare day ends at midnight in the zone');
    assert.equal(typedDeadline('2030-01-09 12:00', now, JERUSALEM)?.toISOString(), '2030-01-09T10:00:00.000Z', 'a typed minute is on the zone clock');
    assert.equal(typedDeadline('12:00 UTC', now, JERUSALEM)?.toISOString(), '2030-01-08T12:00:00.000Z');
    assert.equal(typedDeadline('tomorrow', now, JERUSALEM), undefined);
  });
});
