import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from './zone.ts';

function zone(name: string): TimeZone {
  const found = TimeZone.of(name);
  assert.ok(found, name);
  return found;
}

const JERUSALEM = zone('Asia/Jerusalem');
const NEW_YORK = zone('America/New_York');
const SUMMER = new Date('2026-07-01T12:00:00Z');
const WINTER = new Date('2026-12-21T12:00:00Z');

describe('TimeZone.of', () => {
  it('knows the IANA names the system knows, and no other', () => {
    assert.equal(zone('Europe/Berlin').name, 'Europe/Berlin');
    assert.deepEqual(['Mars/Olympus', '', 'IDT'].map((name) => TimeZone.of(name)), [undefined, undefined, undefined]);
  });
});

describe('TimeZone.resolve', () => {
  it("takes the configured zone, else the machine's, else UTC", () => {
    assert.deepEqual(
      [TimeZone.resolve('Asia/Tokyo', 'Asia/Jerusalem'), TimeZone.resolve(undefined, 'Asia/Jerusalem'), TimeZone.resolve('Mars/Olympus', 'Asia/Jerusalem'), TimeZone.resolve(undefined, 'Mars/Olympus')].map((found) => found.name),
      ['Asia/Tokyo', 'Asia/Jerusalem', 'Asia/Jerusalem', 'UTC'],
    );
  });
});

describe('label', () => {
  it("takes the zone's short name, and the initials of its long name where the short one is only an offset", () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['Asia/Jerusalem', 'IDT', 'IST'],
      ['America/New_York', 'EDT', 'EST'],
      ['Europe/London', 'BST', 'GMT'],
      ['Europe/Berlin', 'CEST', 'CET'],
      ['Asia/Tokyo', 'JST', 'JST'],
      ['Australia/Sydney', 'AEST', 'AEDT'],
      ['UTC', 'UTC', 'UTC'],
    ];
    for (const [name, summer, winter] of cases) {
      assert.deepEqual([zone(name).label(SUMMER), zone(name).label(WINTER)], [summer, winter], name);
    }
  });

  it('keeps the offset where the long name is no words to take initials of', () => {
    assert.equal(zone('Etc/GMT-3').label(SUMMER), 'GMT+3');
  });
});

describe('formats', () => {
  it("shows an instant on the zone's clock and calendar, marked with the zone", () => {
    const late = new Date('2026-10-19T22:30:00Z');
    assert.deepEqual(
      [JERUSALEM.minute(late), JERUSALEM.shortMinute(late), JERUSALEM.clock(late), JERUSALEM.day(late), JERUSALEM.weekday(late), JERUSALEM.weekdayMinute(late)],
      ['2026-10-20 01:30 IDT', '10-20 01:30 IDT', '01:30 IDT', '2026-10-20', 'Tue', 'Tue 10-20 01:30 IDT'],
    );
    assert.equal(TimeZone.UTC.weekdayMinute(late), 'Mon 10-19 22:30 UTC', 'the weekday is the one on the clock shown');
    assert.equal(TimeZone.UTC.minute(late), '2026-10-19 22:30 UTC');
    assert.equal(NEW_YORK.minute(late), '2026-10-19 18:30 EDT');
  });

  it('reads the offset either side of a change of clocks', () => {
    assert.deepEqual(
      [JERUSALEM.offsetMs(new Date('2026-10-24T22:59:00Z')), JERUSALEM.offsetMs(new Date('2026-10-24T23:00:00Z'))],
      [3 * 3_600_000, 2 * 3_600_000],
    );
    assert.equal(NEW_YORK.offsetMs(WINTER), -5 * 3_600_000);
  });
});

describe('instant', () => {
  it("finds the instant the zone's clock shows a wall time at", () => {
    assert.equal(JERUSALEM.instant({ year: 2026, month: 10, day: 20, hour: 9, minute: 0 }).toISOString(), '2026-10-20T06:00:00.000Z');
    assert.equal(JERUSALEM.instant({ year: 2026, month: 12, day: 1, hour: 0, minute: 0 }, 1).toISOString(), '2026-11-30T22:00:00.001Z');
    assert.equal(TimeZone.UTC.instant({ year: 2030, month: 1, day: 31, hour: 8, minute: 5 }).toISOString(), '2030-01-31T08:05:00.000Z');
  });

  it('takes the earlier of a time shown twice as summer time ends, east and west of Greenwich', () => {
    assert.equal(JERUSALEM.instant({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }).toISOString(), '2026-10-24T22:30:00.000Z');
    assert.equal(NEW_YORK.instant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }).toISOString(), '2026-11-01T05:30:00.000Z');
  });

  it('moves a time skipped as summer time starts on by the skip', () => {
    const skipped = NEW_YORK.instant({ year: 2027, month: 3, day: 14, hour: 2, minute: 30 });
    assert.deepEqual([skipped.toISOString(), NEW_YORK.clock(skipped)], ['2027-03-14T07:30:00.000Z', '03:30 EDT']);
  });
});
