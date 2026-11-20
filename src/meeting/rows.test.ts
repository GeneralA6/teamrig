import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_DAY, MS_PER_MINUTE } from '../core/time.ts';
import { meetingRows } from './rows.ts';
import type { ScheduledMeeting } from './schedule.ts';

const AT = Date.parse('2030-01-08T09:15:00Z');
const HOUR = 60 * MS_PER_MINUTE;

function meeting(overrides: Partial<ScheduledMeeting> = {}): ScheduledMeeting {
  return {
    id: 'M1',
    at: AT,
    minutes: 30,
    session: 'ops',
    with: [],
    tasks: [],
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

/** A zone's text stands in: the row carries whatever the caller's zone says. */
function atText(at: Date): string {
  return `at ${at.toISOString().slice(11, 16)}`;
}

describe('meetingRows', () => {
  it('gives one row per meeting with its start as an instant and as the caller words it', () => {
    const rows = meetingRows({
      meetings: [meeting({ with: ['web'], tasks: ['T7', 'T9'], brief: 'notes/ops/brief.md', minutes: 45 })],
      all: false,
      now: AT - HOUR,
      atText,
    });
    assert.deepEqual(rows, [
      {
        id: 'M1',
        at: '2030-01-08T09:15:00.000Z',
        atText: 'at 09:15',
        minutes: 45,
        session: 'ops',
        with: ['web'],
        tasks: ['T7', 'T9'],
        about: 'the release plan',
        brief: 'notes/ops/brief.md',
        status: 'scheduled',
        missed: false,
      },
    ]);
  });

  it('orders them by time, the earlier id first at one time', () => {
    const meetings = [meeting({ id: 'M3', at: AT + HOUR }), meeting({ id: 'M10', at: AT }), meeting({ id: 'M2', at: AT })];
    const rows = meetingRows({ meetings, all: false, now: AT - HOUR, atText });
    assert.deepEqual(rows.map((row) => row.id), ['M2', 'M10', 'M3']);
  });

  it('leaves out the meetings done or dropped unless all are asked for', () => {
    const meetings = [
      meeting({ id: 'M1', status: 'done' }),
      meeting({ id: 'M2', status: 'started' }),
      meeting({ id: 'M3', status: 'dropped' }),
      meeting({ id: 'M4' }),
    ];
    const open = meetingRows({ meetings, all: false, now: AT - HOUR, atText });
    assert.deepEqual(open.map((row) => [row.id, row.status]), [['M2', 'started'], ['M4', 'scheduled']]);
    const all = meetingRows({ meetings, all: true, now: AT - HOUR, atText });
    assert.deepEqual(all.map((row) => [row.id, row.status]), [['M1', 'done'], ['M2', 'started'], ['M3', 'dropped'], ['M4', 'scheduled']]);
  });

  it('marks a meeting missed once its slot is over while it is still scheduled, and no started one', () => {
    const meetings = [meeting({ id: 'M1' }), meeting({ id: 'M2', status: 'started' })];
    const justBefore = meetingRows({ meetings, all: false, now: AT + 30 * MS_PER_MINUTE - 1, atText });
    assert.deepEqual(justBefore.map((row) => row.missed), [false, false]);
    const atItsEnd = meetingRows({ meetings, all: false, now: AT + 30 * MS_PER_MINUTE, atText });
    assert.deepEqual(atItsEnd.map((row) => [row.id, row.missed]), [['M1', true], ['M2', false]]);
  });
});
