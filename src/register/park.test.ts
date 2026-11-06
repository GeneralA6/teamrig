import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_DAY } from '../core/time.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import { wouldPark, type ParkFocus, type ParkInput } from './park.ts';

const FOCUS: ParkFocus = { roadmapClass: 'Roadmap', maintenanceClass: 'Maintenance', parkAfterDays: 14 };

const NOW = Date.parse('2030-02-01T09:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW - days * MS_PER_DAY).toISOString();
}

function input(overrides: Partial<ParkInput> = {}): ParkInput {
  return { focus: FOCUS, ownerSource: 'owner', now: NOW, needed: () => false, ...overrides };
}

/** A task the park rule would take: a stored Improvements class, open, quiet past the limit, nothing holding it. */
function parkable(overrides: Partial<Task> = {}): Task {
  return testTask({ workClass: 'Improvements', updatedAt: daysAgo(15), ...overrides });
}

describe('wouldPark', () => {
  it('parks a quiet, open, stored Improvements task', () => {
    assert.equal(wouldPark(parkable(), input()), true);
  });

  it('parks at exactly the limit', () => {
    assert.equal(wouldPark(parkable({ updatedAt: daysAgo(14) }), input()), true);
  });

  it('never parks a null class, however quiet', () => {
    assert.equal(wouldPark(parkable({ workClass: null }), input()), false);
  });

  it('never parks a Roadmap or a Maintenance class', () => {
    assert.equal(wouldPark(parkable({ workClass: 'Roadmap' }), input()), false);
    assert.equal(wouldPark(parkable({ workClass: 'Maintenance' }), input()), false);
  });

  it('parks a team\'s own Improvements-like class', () => {
    assert.equal(wouldPark(parkable({ workClass: 'Chores' }), input()), true);
  });

  for (const status of ['in-progress', 'waiting', 'verifying'] as const) {
    it(`leaves a ${status} task`, () => {
      assert.equal(wouldPark(parkable({ status }), input()), false);
    });
  }

  it('leaves a task with an event inside the limit', () => {
    assert.equal(wouldPark(parkable({ updatedAt: daysAgo(13) }), input()), false);
  });

  it('leaves a pinned task', () => {
    assert.equal(wouldPark(parkable({ pin: 'lead' }), input()), false);
  });

  it('leaves a critical task', () => {
    assert.equal(wouldPark(parkable({ critical: true }), input()), false);
  });

  it('leaves an owner-sourced task, by the team\'s own source name', () => {
    assert.equal(wouldPark(parkable({ source: 'boss' }), input({ ownerSource: 'boss' })), false);
  });

  it('leaves a task an active task needs', () => {
    assert.equal(wouldPark(parkable({ id: 'T7' }), input({ needed: (id) => id === 'T7' })), false);
  });

  it('leaves a row that holds no date, as nothing says it is quiet', () => {
    assert.equal(wouldPark({ id: 'T1', status: 'open', workClass: 'Improvements' }, input()), false);
  });

  it('parks a smaller row by the same rule, its absent pin and flags counting as none', () => {
    assert.equal(wouldPark({ id: 'T1', status: 'open', workClass: 'Improvements', updatedAt: daysAgo(15) }, input()), true);
  });

  it('leaves a smaller row with no class', () => {
    assert.equal(wouldPark({ id: 'T1', status: 'open', updatedAt: daysAgo(15) }, input()), false);
  });
});
