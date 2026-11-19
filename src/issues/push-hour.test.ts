import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hourSent, minuteOf, parsePushHour, PUSH_HOUR_FORMAT, pushHourText, shiftWrites, type PushHour } from './push-hour.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-19T20:00:30Z');
const THIS_MINUTE = Date.parse('2026-11-19T20:00:00Z');

describe('parsePushHour', () => {
  it('reads no file as an hour with no writes', () => {
    assert.deepEqual(parsePushHour(undefined), { kind: 'read', hour: [] });
  });

  it('reads back what pushHourText wrote, oldest minute first', () => {
    const hour: PushHour = [
      { minute: THIS_MINUTE - 2 * MINUTE, writes: 3 },
      { minute: THIS_MINUTE, writes: 40 },
    ];
    assert.deepEqual(parsePushHour(pushHourText([...hour].reverse())), { kind: 'read', hour });
  });

  for (const [name, text] of [
    ['torn JSON', '{"v":1,"minutes":['],
    ['an empty file', ''],
    ['a list, not an object', '[]'],
    ['another format', JSON.stringify({ v: PUSH_HOUR_FORMAT + 1, minutes: [] })],
    ['no minutes list', JSON.stringify({ v: PUSH_HOUR_FORMAT })],
    ['a minute not on a minute start', JSON.stringify({ v: PUSH_HOUR_FORMAT, minutes: [{ minute: THIS_MINUTE + 1, writes: 2 }] })],
    ['a negative count', JSON.stringify({ v: PUSH_HOUR_FORMAT, minutes: [{ minute: THIS_MINUTE, writes: -1 }] })],
    ['a count that is not a number', JSON.stringify({ v: PUSH_HOUR_FORMAT, minutes: [{ minute: THIS_MINUTE, writes: '4' }] })],
  ] as const) {
    it(`calls ${name} unreadable, with a reason`, () => {
      const read = parsePushHour(text);
      assert.equal(read.kind, 'unreadable');
      assert.ok(read.kind === 'unreadable' && read.reason.length > 0);
    });
  }
});

describe('hourSent', () => {
  it('sums the minutes of the last hour and leaves out a minute wholly older', () => {
    const hour: PushHour = [
      { minute: THIS_MINUTE - HOUR - MINUTE, writes: 100 },
      { minute: THIS_MINUTE - HOUR + MINUTE, writes: 7 },
      { minute: THIS_MINUTE, writes: 5 },
    ];
    assert.equal(hourSent(hour, NOW), 12);
  });

  it('still counts the minute the hour edge falls in, so it never counts fewer writes than the hour holds', () => {
    // NOW - HOUR is 19:00:30: the 19:00 minute is half inside the hour, and counted whole.
    assert.equal(hourSent([{ minute: THIS_MINUTE - HOUR, writes: 9 }], NOW), 9);
  });

  it('counts nothing in an empty hour', () => {
    assert.equal(hourSent([], NOW), 0);
  });
});

describe('minuteOf', () => {
  it('gives the start of the minute', () => {
    assert.equal(minuteOf(NOW), THIS_MINUTE);
    assert.equal(minuteOf(THIS_MINUTE), THIS_MINUTE);
  });
});

describe('shiftWrites', () => {
  it("adds a run's writes to its minute and drops the minutes past the hour", () => {
    const hour: PushHour = [
      { minute: THIS_MINUTE - 2 * HOUR, writes: 40 },
      { minute: THIS_MINUTE - 10 * MINUTE, writes: 4 },
      { minute: THIS_MINUTE, writes: 2 },
    ];
    assert.deepEqual(shiftWrites(hour, NOW, THIS_MINUTE, 38), [
      { minute: THIS_MINUTE - 10 * MINUTE, writes: 4 },
      { minute: THIS_MINUTE, writes: 40 },
    ]);
  });

  it('makes a minute for a run in a new one', () => {
    assert.deepEqual(shiftWrites([], NOW, THIS_MINUTE, 6), [{ minute: THIS_MINUTE, writes: 6 }]);
  });

  it('takes back what a run reserved and did not send, down to none, and drops an empty minute', () => {
    const reserved: PushHour = [{ minute: THIS_MINUTE, writes: 40 }];
    assert.deepEqual(shiftWrites(reserved, NOW, THIS_MINUTE, -38), [{ minute: THIS_MINUTE, writes: 2 }]);
    assert.deepEqual(shiftWrites(reserved, NOW, THIS_MINUTE, -40), []);
    assert.deepEqual(shiftWrites(reserved, NOW, THIS_MINUTE, -45), []);
  });

  it('adds nothing to a minute already past the hour, but still prunes', () => {
    assert.deepEqual(shiftWrites([{ minute: THIS_MINUTE - 2 * HOUR, writes: 3 }], NOW, THIS_MINUTE - 2 * HOUR, 5), []);
  });
});
