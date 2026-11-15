import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DAY_SCHEDULE_KEEP_DAYS,
  formatDaySchedule,
  isScheduleDay,
  parseDaySchedule,
  parseScheduledStart,
  resolveDayStart,
  scheduledStartOn,
  scheduledStartText,
  startsOn,
  withDayStarts,
  type DaySchedule,
  type ScheduledStart,
} from './schedule.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIDNIGHT = Date.parse('2030-01-08T00:00:00.000Z');
const KEYS = ['web/ui', 'web'];

function at(text: string): ScheduledStart {
  const start = parseScheduledStart(text);
  assert.ok(start !== undefined);
  return start;
}

function scheduleOf(days: Readonly<Record<string, Readonly<Record<string, string>>>>): DaySchedule {
  return { days: new Map(Object.entries(days).map(([day, entries]) => [day, new Map(Object.entries(entries).map(([key, value]) => [key, at(value)]))])) };
}

describe('the day schedule', () => {
  it('reads starts as HH:MM UTC or none, and real UTC days only', () => {
    assert.deepEqual(parseScheduledStart('06:30'), { kind: 'at', minute: 390 });
    assert.deepEqual(parseScheduledStart('none'), { kind: 'none' });
    assert.equal(parseScheduledStart('6:30'), undefined);
    assert.equal(parseScheduledStart('later'), undefined);
    assert.equal(scheduledStartText(at('06:05')), '06:05');
    assert.equal(scheduledStartText(at('none')), 'none');
    assert.equal(isScheduleDay('2030-01-08'), true);
    assert.equal(isScheduleDay('2030-02-30'), false);
    assert.equal(isScheduleDay('2030-1-8'), false);
  });

  it('round-trips through its file, leaving out a day or entry it cannot read', () => {
    const schedule = scheduleOf({ '2030-01-09': { web: '07:00', 'web/ui': 'none' }, '2030-01-08': { web: '06:00' } });
    const text = formatDaySchedule(schedule);
    assert.equal(text, '{"v":1,"days":{"2030-01-08":{"web":"06:00"},"2030-01-09":{"web":"07:00","web/ui":"none"}}}\n');
    assert.deepEqual(parseDaySchedule(text), schedule);
    const damaged = parseDaySchedule('{"v":1,"days":{"2030-01-08":{"web":"6am","api":"05:00","":"05:00"},"someday":{"web":"05:00"},"2030-01-09":[]}}');
    assert.deepEqual(damaged, scheduleOf({ '2030-01-08': { api: '05:00' } }));
  });

  it('reads no schedule from another format or no object', () => {
    assert.equal(parseDaySchedule('{"v":2,"days":{}}'), undefined);
    assert.equal(parseDaySchedule('{"days":{}}'), undefined);
    assert.equal(parseDaySchedule('{"v":1,"days":[]}'), undefined);
    assert.equal(parseDaySchedule('not json'), undefined);
  });

  it('writes a day over what it held and drops days too far behind the newest', () => {
    const old = scheduleOf({ '2029-12-01': { web: '06:00' }, '2030-01-08': { web: '06:00', api: '05:00' } });
    const written = withDayStarts(old, '2030-01-08', new Map([['web', at('09:00')]]));
    assert.deepEqual(written, scheduleOf({ '2030-01-08': { web: '09:00', api: '05:00' } }));
    const edge = withDayStarts(undefined, '2030-01-08', new Map([['web', at('06:00')]]));
    const later = withDayStarts(edge, `2030-01-${String(8 + DAY_SCHEDULE_KEEP_DAYS).padStart(2, '0')}`, new Map([['web', at('06:00')]]));
    assert.equal(later.days.has('2030-01-08'), true);
  });

  it('takes the session entry over the team one, and repeats the newest earlier day without one', () => {
    const schedule = scheduleOf({ '2030-01-06': { 'web/ui': '05:00' }, '2030-01-07': { web: '07:00' }, '2030-01-08': { web: '08:00', 'web/ui': '09:00' } });
    assert.deepEqual(scheduledStartOn(schedule, KEYS, '2030-01-08'), { start: at('09:00'), source: 'schedule' });
    assert.deepEqual(scheduledStartOn(schedule, ['web/api', 'web'], '2030-01-08'), { start: at('08:00'), source: 'schedule' });
    assert.deepEqual(scheduledStartOn(schedule, KEYS, '2030-01-10'), { start: at('09:00'), source: 'repeat' });
    assert.deepEqual(scheduledStartOn(schedule, KEYS, '2030-01-07'), { start: at('07:00'), source: 'schedule' });
    assert.equal(scheduledStartOn(schedule, KEYS, '2030-01-05'), undefined);
  });

  it('never repeats a day written ahead of today', () => {
    const schedule = scheduleOf({ '2030-01-09': { web: '07:00' } });
    assert.equal(scheduledStartOn(schedule, KEYS, '2030-01-08'), undefined);
  });
});

describe('resolveDayStart', () => {
  it('keeps wake.dayStartUtc as before with no schedule, or one that never names the session', () => {
    const noon = MIDNIGHT + 12 * HOUR;
    const expected = { at: MIDNIGHT + 6 * HOUR, next: MIDNIGHT + DAY + 6 * HOUR, source: 'config' };
    assert.deepEqual(resolveDayStart(undefined, KEYS, '06:00', noon), expected);
    assert.deepEqual(resolveDayStart(scheduleOf({ '2030-01-08': { api: '05:00' } }), KEYS, '06:00', noon), expected);
    // Before today's start, yesterday's is still the one reached, as dayStartAt always gave.
    assert.deepEqual(resolveDayStart(undefined, KEYS, '06:00', MIDNIGHT + HOUR), { at: MIDNIGHT - DAY + 6 * HOUR, next: MIDNIGHT + 6 * HOUR, source: 'config' });
    assert.deepEqual(resolveDayStart(undefined, KEYS, undefined, noon), { at: undefined, next: undefined, source: 'config' });
  });

  it("gives today's scheduled start once reached, and no start before it (never yesterday's)", () => {
    const schedule = scheduleOf({ '2030-01-07': { web: '06:00' }, '2030-01-08': { web: '09:00' }, '2030-01-09': { web: '05:00' } });
    assert.deepEqual(resolveDayStart(schedule, KEYS, '06:00', MIDNIGHT + 7 * HOUR), { at: undefined, next: MIDNIGHT + 9 * HOUR, source: 'schedule' });
    assert.deepEqual(resolveDayStart(schedule, KEYS, '06:00', MIDNIGHT + 10 * HOUR), { at: MIDNIGHT + 9 * HOUR, next: MIDNIGHT + DAY + 5 * HOUR, source: 'schedule' });
  });

  it('starts nothing on a none day and rechecks at the next start, or the day after an empty tomorrow', () => {
    const schedule = scheduleOf({ '2030-01-08': { web: 'none' }, '2030-01-09': { web: 'none' } });
    assert.deepEqual(resolveDayStart(schedule, KEYS, '06:00', MIDNIGHT + 10 * HOUR), { at: undefined, next: MIDNIGHT + 2 * DAY, source: 'schedule' });
    const back = scheduleOf({ '2030-01-08': { web: 'none' }, '2030-01-09': { web: '07:00' } });
    assert.deepEqual(resolveDayStart(back, KEYS, '06:00', MIDNIGHT + 10 * HOUR), { at: undefined, next: MIDNIGHT + DAY + 7 * HOUR, source: 'schedule' });
  });

  it('marks a repeated day, with tomorrow repeating the same start', () => {
    const schedule = scheduleOf({ '2030-01-06': { web: '08:00' } });
    assert.deepEqual(resolveDayStart(schedule, KEYS, '06:00', MIDNIGHT + 10 * HOUR), { at: MIDNIGHT + 8 * HOUR, next: MIDNIGHT + DAY + 8 * HOUR, source: 'repeat' });
  });
});

describe('startsOn', () => {
  it("lists each key's start on a day by key, from that day or the newest earlier day naming it, never a later day", () => {
    const schedule = scheduleOf({ '2030-01-06': { web: '08:00', 'web/ui': 'none' }, '2030-01-08': { web: '09:00' }, '2030-01-09': { api: '07:00' } });
    assert.deepEqual(startsOn(schedule, '2030-01-08'), [
      { key: 'web', start: at('09:00'), writtenOn: '2030-01-08' },
      { key: 'web/ui', start: at('none'), writtenOn: '2030-01-06' },
    ]);
    assert.deepEqual(startsOn(schedule, '2030-01-05'), []);
  });
});
