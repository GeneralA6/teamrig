import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { MS_PER_DAY, MS_PER_MINUTE } from '../core/time.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import {
  byTime,
  inBookedMeeting,
  isMeetingId,
  isMissed,
  isNotifyDue,
  keptMeetings,
  MeetingSchedule,
  nextMeetingId,
  nextNotifyAt,
  readMeetings,
  type ScheduledMeeting,
} from './schedule.ts';
import { MEETING_LAPSE_MS } from './state.ts';

const PATH = '/kit/teams/app/state/meetings.jsonl';
const AT = Date.parse('2030-01-08T09:15:00Z');

function meeting(overrides: Partial<ScheduledMeeting> = {}): ScheduledMeeting {
  return {
    id: 'M1',
    at: AT,
    minutes: 30,
    session: 'ops',
    with: [],
    tasks: ['T7'],
    about: 'the release plan',
    brief: null,
    status: 'scheduled',
    notifiedAt: null,
    by: 'lead',
    changedAt: AT - MS_PER_DAY,
    note: null,
    ...overrides,
  };
}

describe('MeetingSchedule', () => {
  it('writes a meeting and reads it back, one line per meeting, the newest record winning', async () => {
    const files = new MemoryFiles();
    const schedule = new MeetingSchedule(files, PATH);
    await schedule.write(meeting(), AT);
    await schedule.write(meeting({ id: 'M2', session: 'alpha', with: ['beta'], brief: 'notes/alpha/brief.md' }), AT);
    await schedule.write(meeting({ at: AT + 60 * MS_PER_MINUTE, notifiedAt: null, note: 'owner moved it' }), AT);
    const read = await schedule.read();
    assert.deepEqual(read.meetings, [meeting({ id: 'M2', session: 'alpha', with: ['beta'], brief: 'notes/alpha/brief.md' }), meeting({ at: AT + 60 * MS_PER_MINUTE, note: 'owner moved it' })]);
    assert.equal(read.skipped, 0);
    assert.equal((await files.read(PATH))?.split('\n').filter((line) => line !== '').length, 2);
  });

  it('skips damaged lines and lines of another format, and drops them at the next write', async () => {
    const files = new MemoryFiles({ [PATH]: '{"v":1,"id":"T3"}\nnot json\n{"v":0,"id":"M9"}\n' });
    const schedule = new MeetingSchedule(files, PATH);
    assert.deepEqual(await schedule.read(), { meetings: [], skipped: 3, lastNumber: 0 });
    await schedule.write(meeting(), AT);
    assert.deepEqual(await schedule.read(), { meetings: [meeting()], skipped: 0, lastNumber: 1 });
  });

  it('refuses to write beside a record of a newer teamrig', async () => {
    const files = new MemoryFiles({ [PATH]: '{"v":2,"id":"M1"}\n' });
    await assert.rejects(new MeetingSchedule(files, PATH).write(meeting(), AT), NewerDataError);
  });

  it('drops a meeting finished more than 8 days back at a write, but keeps the highest id so it is never reused', async () => {
    const files = new MemoryFiles();
    const schedule = new MeetingSchedule(files, PATH);
    const old = AT - 9 * MS_PER_DAY;
    await schedule.write(meeting({ status: 'done', changedAt: old }), old);
    await schedule.write(meeting({ id: 'M2', status: 'dropped', changedAt: old }), old);
    await schedule.write(meeting({ id: 'M3' }), AT);
    const read = await schedule.read();
    assert.deepEqual(read.meetings.map((kept) => kept.id), ['M2', 'M3']);
    assert.equal(nextMeetingId(read), 'M4');
  });
});

describe('readMeetings', () => {
  it('numbers the next meeting after the highest id the file holds', () => {
    const text = [meeting({ id: 'M4' }), meeting({ id: 'M2' })].map((record) => JSON.stringify({ v: 1, ...record, at: new Date(record.at).toISOString(), changedAt: new Date(record.changedAt).toISOString() })).join('\n');
    assert.equal(nextMeetingId(readMeetings(text)), 'M5');
    assert.equal(nextMeetingId(readMeetings('')), 'M1');
  });
});

describe('meeting views', () => {
  it('takes only M<n> ids', () => {
    assert.equal(isMeetingId('M12'), true);
    assert.equal(isMeetingId('M0'), false);
    assert.equal(isMeetingId('T12'), false);
    assert.equal(isMeetingId('m3'), false);
  });

  it('is missed once its slot is over with no start, and only while scheduled', () => {
    const end = AT + 30 * MS_PER_MINUTE;
    assert.equal(isMissed(meeting(), end - 1), false);
    assert.equal(isMissed(meeting(), end), true);
    assert.equal(isMissed(meeting({ status: 'started' }), end + MS_PER_DAY), false);
  });

  it('is due for its notification from its time to the end of its slot, once', () => {
    assert.equal(isNotifyDue(meeting(), AT - 1), false);
    assert.equal(isNotifyDue(meeting(), AT), true);
    assert.equal(isNotifyDue(meeting({ notifiedAt: AT }), AT + 1), false);
    assert.equal(isNotifyDue(meeting(), AT + 30 * MS_PER_MINUTE), false);
    assert.equal(isNotifyDue(meeting({ status: 'dropped' }), AT), false);
  });

  it('names the next notification time, none when nothing is scheduled ahead', () => {
    const meetings = [meeting({ id: 'M1', at: AT + 2000 }), meeting({ id: 'M2', at: AT + 1000 }), meeting({ id: 'M3', at: AT + 500, notifiedAt: AT }), meeting({ id: 'M4', at: AT - 1 })];
    assert.equal(nextNotifyAt(meetings, AT), AT + 1000);
    assert.equal(nextNotifyAt([meeting({ status: 'done' })], AT - 1), null);
  });

  it('sorts by time, ids breaking a tie', () => {
    const sorted = byTime([meeting({ id: 'M10', at: AT }), meeting({ id: 'M2', at: AT + 1 }), meeting({ id: 'M9', at: AT })]);
    assert.deepEqual(sorted.map((one) => one.id), ['M9', 'M10', 'M2']);
  });

  it('keeps every open meeting however old, and finished ones of the last 8 days', () => {
    const now = AT + 20 * MS_PER_DAY;
    const read = { meetings: [meeting({ id: 'M1' }), meeting({ id: 'M2', status: 'done', changedAt: now - 7 * MS_PER_DAY }), meeting({ id: 'M3', status: 'done', changedAt: now - 9 * MS_PER_DAY }), meeting({ id: 'M4', status: 'started' })], skipped: 0, lastNumber: 5 };
    assert.deepEqual(keptMeetings(read, now).map((kept) => kept.id), ['M1', 'M2', 'M4']);
  });

  it('holds the session met and those joining a started meeting from its start to its end, drop or lapse (T2111)', () => {
    const start = AT - 15 * MS_PER_MINUTE;
    const started = meeting({ status: 'started', with: ['beta'], changedAt: start });
    const later = start + 3 * 60 * MS_PER_MINUTE;
    assert.equal(inBookedMeeting([started], 'ops', later), true, 'the session met, past its 30 minutes');
    assert.equal(inBookedMeeting([started], 'beta', later), true, 'a session joining');
    assert.equal(inBookedMeeting([started], 'alpha', later), false, 'another session works on');
    assert.equal(inBookedMeeting([started], 'ops', start + MEETING_LAPSE_MS), false, 'lapsed 4 hours after its start');
    assert.equal(inBookedMeeting([meeting({ changedAt: start })], 'ops', AT), false, 'a scheduled one whose time came holds nothing before its start');
    assert.equal(inBookedMeeting([meeting({ status: 'done', changedAt: start }), meeting({ id: 'M2', status: 'dropped', changedAt: start })], 'ops', AT), false, 'ended or dropped');
    assert.equal(inBookedMeeting([], 'ops', AT), false);
  });
});
