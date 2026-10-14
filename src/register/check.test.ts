import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testConfig } from '../testing/config.ts';
import { testTask } from '../testing/task.ts';
import { checkTasks, currentWeek, formatFlag } from './check.ts';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const FRESH = '2030-01-10T09:00:00.000Z';
const CONFIG = testConfig().register;

describe('currentWeek', () => {
  it('picks the newest week tag that has started', () => {
    const tasks = [testTask({ week: '2030-01-07' }), testTask({ week: '2029-12-31' }), testTask({ week: '2030-01-14' })];
    assert.equal(currentWeek(tasks, NOW), '2030-01-07');
    assert.equal(currentWeek([testTask()], NOW), null);
  });
});

describe('checkTasks', () => {
  const kinds = (tasks: Parameters<typeof checkTasks>[0], week: string | null = null) =>
    checkTasks(tasks, NOW, week, CONFIG).map((flag) => `${flag.kind} ${flag.task.id}`);

  it('flags overdue tasks; a bare day is due at its end', () => {
    assert.deepEqual(kinds([testTask({ due: '2030-01-09', ownerSeenAt: FRESH, updatedAt: FRESH })]), ['OVERDUE T1']);
    assert.deepEqual(kinds([testTask({ due: '2030-01-10', ownerSeenAt: FRESH, updatedAt: FRESH })]), []);
  });

  it('flags a task its owner has not touched since assignment, instead of calling it stale', () => {
    assert.deepEqual(kinds([testTask({ assignedAt: '2030-01-09T11:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z' })]), [
      'NOT-PICKED-UP T1',
    ]);
    assert.deepEqual(kinds([testTask({ assignedAt: '2030-01-09T13:00:00.000Z', updatedAt: FRESH })]), []);
  });

  it('flags tasks with no event for the stale window', () => {
    const old = testTask({ ownerSeenAt: '2030-01-07T08:00:00.000Z', updatedAt: '2030-01-07T11:00:00.000Z', updatedBy: 'bravo' });
    const flags = checkTasks([old], NOW, null, CONFIG);
    assert.deepEqual(flags.map(formatFlag), ['STALE (last event 01-07 11:00 by bravo) T1 t2 open alpha src lead | Add a health check']);
  });

  it('flags owner orders and tasks due this week that are outside the week plan', () => {
    const seen = { ownerSeenAt: FRESH, updatedAt: FRESH };
    const tasks = [
      testTask({ id: 'T1', source: 'owner', ...seen }),
      testTask({ id: 'T2', due: '2030-01-12', ...seen }),
      testTask({ id: 'T3', due: '2030-01-14', ...seen }),
      testTask({ id: 'T4', source: 'owner', week: '2030-01-07', ...seen }),
      testTask({ id: 'T5', source: 'owner', status: 'done', ...seen }),
    ];
    assert.deepEqual(kinds(tasks, '2030-01-07'), ['OWNER-UNPLANNED T1', 'DUE-UNPLANNED T2']);
    assert.deepEqual(kinds(tasks), [], 'no week plan, no week flags');
  });

  it('reports the most urgent kinds first', () => {
    const tasks = [
      testTask({ id: 'T1', ownerSeenAt: FRESH, updatedAt: '2030-01-01T00:00:00.000Z' }),
      testTask({ id: 'T2', due: '2030-01-08', ownerSeenAt: FRESH, updatedAt: FRESH, tier: 4 }),
    ];
    assert.deepEqual(kinds(tasks), ['OVERDUE T2', 'STALE T1']);
  });

  it('reads its thresholds from the config', () => {
    const quick = testConfig({ register: { check: { staleAfterHours: 1, notPickedUpAfterHours: 1, weekLengthDays: 7 } } }).register;
    const flags = checkTasks([testTask({ ownerSeenAt: '2030-01-10T10:00:00.000Z', updatedAt: '2030-01-10T10:00:00.000Z' })], NOW, null, quick);
    assert.deepEqual(flags.map((flag) => flag.kind), ['STALE']);
  });
});
