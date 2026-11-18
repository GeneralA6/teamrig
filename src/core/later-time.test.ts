import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { namedLaterTime } from './later-time.ts';
import { TimeZone } from './zone.ts';

function zoneOf(name: string): TimeZone {
  const zone = TimeZone.of(name);
  assert.ok(zone, name);
  return zone;
}

const JERUSALEM = zoneOf('Asia/Jerusalem');
const NEW_YORK = zoneOf('America/New_York');

/** Tue 2030-01-08 10:00:30 UTC, 12:00 IST. */
const TUESDAY = Date.parse('2030-01-08T10:00:30Z');

describe('namedLaterTime (T4078)', () => {
  it('puts a card off by whole hours from now, to the minute', () => {
    assert.equal(namedLaterTime('in-1h', TUESDAY, JERUSALEM), '2030-01-08 11:00');
    assert.equal(namedLaterTime(' IN-24H ', TUESDAY, JERUSALEM), '2030-01-09 10:00');
    assert.equal(namedLaterTime('in-168h', TUESDAY, JERUSALEM), '2030-01-15 10:00');
  });

  it('refuses no hours, more than a week of them and other spellings, for the caller to read as a typed time', () => {
    for (const text of ['in-0h', 'in-169h', 'in-1', 'in 1h', 'in-1d', '1h', '']) {
      assert.equal(namedLaterTime(text, TUESDAY, JERUSALEM), undefined, text);
    }
  });

  it("puts a card off to 09:00 on the team's clock the next day", () => {
    assert.equal(namedLaterTime('tomorrow', TUESDAY, JERUSALEM), '2030-01-09 07:00');
    assert.equal(namedLaterTime('tomorrow', TUESDAY, NEW_YORK), '2030-01-09 14:00');
    // 23:30 IST on Tuesday is still Tuesday there.
    assert.equal(namedLaterTime('tomorrow', Date.parse('2030-01-08T21:30:00Z'), JERUSALEM), '2030-01-09 07:00');
    // 00:30 IST on Wednesday is Wednesday there, so tomorrow is Thursday, though UTC still reads Tuesday.
    assert.equal(namedLaterTime('tomorrow', Date.parse('2030-01-08T22:30:00Z'), JERUSALEM), '2030-01-10 07:00');
  });

  it('puts a card off to 09:00 next Monday, a week on from a Monday, across a change of clocks', () => {
    assert.equal(namedLaterTime('Monday', TUESDAY, JERUSALEM), '2030-01-14 07:00');
    assert.equal(namedLaterTime('monday', Date.parse('2030-01-13T12:00:00Z'), JERUSALEM), '2030-01-14 07:00', 'from a Sunday');
    assert.equal(namedLaterTime('monday', Date.parse('2030-01-14T05:00:00Z'), JERUSALEM), '2030-01-21 07:00', 'from a Monday before 09:00');
    // New York moves to summer time on Sunday 2030-03-10: Monday 09:00 EDT is 13:00 UTC, not 14:00.
    assert.equal(namedLaterTime('monday', Date.parse('2030-03-08T15:00:00Z'), NEW_YORK), '2030-03-11 13:00');
  });
});
