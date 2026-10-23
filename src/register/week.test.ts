import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { readRegister, type RegisterSnapshot } from './snapshot.ts';
import { currentWeek, currentWeekOf } from './week.ts';

const NOW = new Date('2030-01-10T12:00:00.000Z');

describe('currentWeek', () => {
  it('picks the newest week tag that has started', () => {
    const tasks = [testTask({ week: '2030-01-07' }), testTask({ week: '2029-12-31' }), testTask({ week: '2030-01-14' })];
    assert.equal(currentWeek(tasks, NOW, TimeZone.UTC), '2030-01-07');
    assert.equal(currentWeek([testTask()], NOW, TimeZone.UTC), null);
  });
});

describe('currentWeekOf', () => {
  const withTasks = (weeks: readonly (string | null)[], retired: RegisterSnapshot['retired']): RegisterSnapshot => {
    const empty = readRegister('');
    const tasks = new Map(weeks.map((week, index) => [`T${index + 1}`, testTask({ id: `T${index + 1}`, week })]));
    return { ...empty, state: { ...empty.state, tasks }, retired };
  };

  it('is the current week of the tasks read when nothing is retired, or nothing newer is', () => {
    assert.equal(currentWeekOf(withTasks(['2030-01-07', null], null), NOW, TimeZone.UTC), '2030-01-07');
    assert.equal(currentWeekOf(withTasks(['2030-01-07'], { count: 2, lastWeek: '2029-12-31' }), NOW, TimeZone.UTC), '2030-01-07');
    assert.equal(currentWeekOf(withTasks([null], { count: 2, lastWeek: null }), NOW, TimeZone.UTC), null);
  });

  it('is the newest week of the retired tasks when no task read is in a newer one that has started', () => {
    assert.equal(currentWeekOf(withTasks([null], { count: 1, lastWeek: '2029-12-31' }), NOW, TimeZone.UTC), '2029-12-31');
    assert.equal(currentWeekOf(withTasks(['2029-12-24', '2099-01-05'], { count: 1, lastWeek: '2029-12-31' }), NOW, TimeZone.UTC), '2029-12-31');
    assert.equal(currentWeekOf(withTasks([], { count: 1, lastWeek: '2099-01-05' }), NOW, TimeZone.UTC), null, 'a week that has not started');
  });
});

describe("currentWeek in the team's zone", () => {
  it('starts a week plan at midnight there', () => {
    const tasks = [testTask({ week: '2030-01-14' })];
    const sunday = new Date('2030-01-13T22:30:00.000Z');
    assert.equal(currentWeek(tasks, sunday, JERUSALEM), '2030-01-14', 'Jerusalem is at Mon 01-14 00:30');
    assert.equal(currentWeek(tasks, sunday, TimeZone.UTC), null, 'UTC is at Sun 01-13 22:30');
  });
});
