import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MEETING_NOTICES } from '../config/defaults.ts';
import type { MeetingNoticesConfig } from '../config/types.ts';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../core/time.ts';
import { dueStage, MISSED_ALERT_WINDOW_MS, nextStageAt } from './notice-stage.ts';
import type { ScheduledMeeting } from './schedule.ts';

const AT = Date.parse('2030-01-08T09:15:00Z');
const MIN = MS_PER_MINUTE;

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

function config(overrides: Partial<MeetingNoticesConfig> = {}): MeetingNoticesConfig {
  return { ...DEFAULT_MEETING_NOTICES, ...overrides };
}

describe('dueStage', () => {
  it('is before from ten minutes ahead, start at the slot and missed five minutes in, by default', () => {
    assert.equal(dueStage(meeting(), AT - 10 * MIN - 1, config()), undefined);
    assert.equal(dueStage(meeting(), AT - 10 * MIN, config()), 'before');
    assert.equal(dueStage(meeting(), AT, config()), 'start');
    assert.equal(dueStage(meeting(), AT + 5 * MIN, config()), 'missed');
  });

  it('sends each stage once: a notice at or after its time holds it', () => {
    assert.equal(dueStage(meeting({ notifiedAt: AT - 10 * MIN }), AT - MIN, config()), undefined);
    assert.equal(dueStage(meeting({ notifiedAt: AT - 10 * MIN }), AT, config()), 'start');
    assert.equal(dueStage(meeting({ notifiedAt: AT }), AT + 4 * MIN, config()), undefined);
    assert.equal(dueStage(meeting({ notifiedAt: AT }), AT + 5 * MIN, config()), 'missed');
    assert.equal(dueStage(meeting({ notifiedAt: AT + 5 * MIN }), AT + 20 * MIN, config()), undefined);
  });

  it('sends only the latest stage to a tab that looks late', () => {
    assert.equal(dueStage(meeting(), AT + 2 * MIN, config()), 'start');
    assert.equal(dueStage(meeting(), AT + 2 * MS_PER_HOUR, config()), 'missed');
  });

  it('raises no missed alert past its window, nor for a meeting started, done or dropped', () => {
    assert.equal(dueStage(meeting(), AT + 5 * MIN + MISSED_ALERT_WINDOW_MS, config()), undefined);
    for (const status of ['started', 'done', 'dropped'] as const) {
      assert.equal(dueStage(meeting({ status }), AT + 5 * MIN, config()), undefined, status);
      assert.equal(dueStage(meeting({ status }), AT - MIN, config()), undefined, status);
    }
  });

  it('leaves out each stage its key turns off, and all of them when off', () => {
    assert.equal(dueStage(meeting(), AT - MIN, config({ beforeMinutes: 0 })), undefined);
    assert.equal(dueStage(meeting(), AT + MIN, config({ atStart: false })), undefined);
    assert.equal(dueStage(meeting(), AT + 6 * MIN, config({ missedAfterMinutes: 0 })), 'start');
    assert.equal(dueStage(meeting(), AT + 31 * MIN, config({ missedAfterMinutes: 0 })), undefined);
    assert.equal(dueStage(meeting(), AT - MIN, config({ beforeMinutes: 30 })), 'before');
    for (const at of [AT - MIN, AT, AT + 5 * MIN]) {
      assert.equal(dueStage(meeting(), at, config({ enabled: false })), undefined);
    }
  });
});

describe('nextStageAt', () => {
  it('names the earliest stage still ahead of any meeting, none when nothing is', () => {
    const meetings = [meeting({ id: 'M1', at: AT + 60 * MIN }), meeting({ id: 'M2', at: AT, notifiedAt: AT - 10 * MIN })];
    assert.equal(nextStageAt(meetings, AT - MIN, config()), AT);
    assert.equal(nextStageAt(meetings, AT, config()), AT + 5 * MIN);
    assert.equal(nextStageAt(meetings, AT + 5 * MIN, config()), AT + 50 * MIN);
    assert.equal(nextStageAt([meeting({ status: 'done' })], AT - MS_PER_HOUR, config()), null);
    assert.equal(nextStageAt([meeting()], AT - MS_PER_HOUR, config({ enabled: false })), null);
  });
});
