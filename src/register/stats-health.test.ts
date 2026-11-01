import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JERUSALEM } from '../testing/zone.ts';
import { EVENT_VERSION } from './events.ts';
import { HEALTH_THRESHOLDS, registerHealth, type HealthInput } from './stats-health.ts';
import { RECENT_DAYS, registerStats } from './stats.ts';

/** A quiet register: nothing opened, closed, overdue or waiting, 10 tasks active, 7 more closed than opened in 4 weeks. */
const QUIET: HealthInput = {
  opened: 0,
  closedTasks: 0,
  net: 0,
  active: { open: 4, 'in-progress': 3, verifying: 2, waiting: 1 },
  recent: { days: RECENT_DAYS, net: -7 },
  all: { overdue: { count: 0, p1: 0 } },
  waits: { ownerDecisions: { count: 0, oldestDays: null } },
};

function healthOf(more: Partial<HealthInput>): ReturnType<typeof registerHealth> {
  return registerHealth({ ...QUIET, ...more });
}

describe('registerHealth: close/open', () => {
  it('is good with nothing opened, and gives no ratio', () => {
    assert.deepEqual(healthOf({ closedTasks: 3 }).closeOpen, { level: 'good', ratio: null });
  });

  it('is bad under 0.9, a warning under 1, good from 1', () => {
    assert.deepEqual(healthOf({ opened: 10, closedTasks: 8 }).closeOpen, { level: 'bad', ratio: 0.8 });
    assert.deepEqual(healthOf({ opened: 10, closedTasks: 9 }).closeOpen, { level: 'warn', ratio: 0.9 });
    assert.deepEqual(healthOf({ opened: 10, closedTasks: 10 }).closeOpen, { level: 'good', ratio: 1 });
  });
});

describe('registerHealth: backlog', () => {
  it('is good when the backlog did not grow', () => {
    assert.deepEqual(healthOf({ net: -2 }).backlog, { level: 'good', net: -2, active: 10 });
    assert.equal(healthOf({ net: 0 }).backlog.level, 'good');
  });

  it('is a warning up to 5% of the active work, bad past it', () => {
    const hundred = { open: 100, 'in-progress': 0, verifying: 0, waiting: 0 };
    assert.deepEqual(healthOf({ net: 5, active: hundred }).backlog, { level: 'warn', net: 5, active: 100 });
    assert.equal(healthOf({ net: 6, active: hundred }).backlog.level, 'bad');
  });
});

describe('registerHealth: overdue', () => {
  it('is good with none, a warning with some, bad with a p1 among them', () => {
    assert.deepEqual(healthOf({}).overdue, { level: 'good', count: 0, p1: 0 });
    assert.deepEqual(healthOf({ all: { overdue: { count: 3, p1: 0 } } }).overdue, { level: 'warn', count: 3, p1: 0 });
    assert.deepEqual(healthOf({ all: { overdue: { count: 3, p1: 1 } } }).overdue, { level: 'bad', count: 3, p1: 1 });
  });
});

describe('registerHealth: owner decisions', () => {
  it('is good with none waiting or the oldest 2 days old', () => {
    assert.deepEqual(healthOf({}).ownerDecisions, { level: 'good', count: 0, oldestDays: null });
    assert.equal(healthOf({ waits: { ownerDecisions: { count: 2, oldestDays: 2 } } }).ownerDecisions.level, 'good');
  });

  it('is a warning over 2 days, bad over 7', () => {
    assert.deepEqual(healthOf({ waits: { ownerDecisions: { count: 2, oldestDays: 2.5 } } }).ownerDecisions, { level: 'warn', count: 2, oldestDays: 2.5 });
    assert.equal(healthOf({ waits: { ownerDecisions: { count: 2, oldestDays: 7 } } }).ownerDecisions.level, 'warn');
    assert.equal(healthOf({ waits: { ownerDecisions: { count: 2, oldestDays: 7.1 } } }).ownerDecisions.level, 'bad');
  });
});

describe('registerHealth: backlog clears', () => {
  it('is 0 weeks with nothing active, whatever the trend', () => {
    const none = { open: 0, 'in-progress': 0, verifying: 0, waiting: 0 };
    assert.deepEqual(healthOf({ active: none, recent: { days: RECENT_DAYS, net: 3 } }).backlogClears, { level: 'good', weeks: 0 });
  });

  it('is never, and bad, while the recent net does not shrink the backlog', () => {
    assert.deepEqual(healthOf({ recent: { days: RECENT_DAYS, net: 0 } }).backlogClears, { level: 'bad', weeks: null });
    assert.deepEqual(healthOf({ recent: { days: RECENT_DAYS, net: 4 } }).backlogClears, { level: 'bad', weeks: null });
  });

  it('rounds the weeks up at the recent net per week: a warning over 4 weeks', () => {
    assert.deepEqual(healthOf({ recent: { days: RECENT_DAYS, net: -12 } }).backlogClears, { level: 'good', weeks: 4 });
    assert.deepEqual(healthOf({ recent: { days: RECENT_DAYS, net: -7 } }).backlogClears, { level: 'warn', weeks: 6 });
  });
});

describe('registerHealth: thresholds and the fold', () => {
  it('keeps the design defaults (T1419 section 2)', () => {
    assert.deepEqual(HEALTH_THRESHOLDS, {
      closeOpen: { bad: 0.9, warn: 1 },
      backlog: { badShare: 0.05 },
      ownerDecisions: { badDays: 7, warnDays: 2 },
      backlogClears: { warnWeeks: 4 },
    });
  });

  it("reads the fold's own numbers", () => {
    const stats = registerStats({
      teams: [
        {
          team: 'alpha',
          lead: 'lead',
          events: [
            {
              v: EVENT_VERSION,
              type: 'create',
              id: 'T1',
              at: '2030-01-09T10:00:00.000Z',
              by: 'lead',
              task: { title: 'Ship it', description: null, owner: 'alpha', source: 'lead', ref: null, priority: 1, due: '2030-01-09', goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null },
            },
          ],
        },
      ],
      range: '7d',
      now: new Date('2030-01-10T10:00:00.000Z'),
      zone: JERUSALEM,
      ownerMarker: 'owner',
    });
    assert.deepEqual(registerHealth(stats), {
      closeOpen: { level: 'bad', ratio: 0 },
      backlog: { level: 'bad', net: 1, active: 1 },
      overdue: { level: 'bad', count: 1, p1: 1 },
      ownerDecisions: { level: 'good', count: 0, oldestDays: null },
      backlogClears: { level: 'bad', weeks: null },
    });
  });
});
