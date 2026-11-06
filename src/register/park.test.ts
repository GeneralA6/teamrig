import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeadTree } from '../config/lead-tree.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { testConfig } from '../testing/config.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import { isUntriaged, wouldPark, type ParkFocus, type ParkInput } from './park.ts';

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

describe('isUntriaged', () => {
  const LEADERS = new LeadTree(testConfig({ sessions: ['lead', 'alpha', 'bravo', 'charlie'], leads: { alpha: ['bravo'] } }));

  it("reads a task with no class as untriaged when a session added it for itself or a peer", () => {
    assert.equal(isUntriaged(testTask({ owner: 'bravo', createdBy: 'bravo' }), LEADERS), true);
    assert.equal(isUntriaged(testTask({ owner: 'bravo', createdBy: 'charlie' }), LEADERS), true);
  });

  it('takes the add of any leader on the owner\'s chain as the triage', () => {
    assert.equal(isUntriaged(testTask({ owner: 'bravo', createdBy: 'alpha' }), LEADERS), false, 'its sub-lead');
    assert.equal(isUntriaged(testTask({ owner: 'bravo', createdBy: 'lead' }), LEADERS), false, 'the lead over its sub-lead');
  });

  it('reads a member\'s add on its leader\'s task as untriaged: the chain runs up from the owner only', () => {
    assert.equal(isUntriaged(testTask({ owner: 'alpha', createdBy: 'bravo' }), LEADERS), true);
  });

  it("takes the lead's add on its own task as the triage, and no one else's on it", () => {
    assert.equal(isUntriaged(testTask({ owner: 'lead', createdBy: 'lead' }), LEADERS), false);
    assert.equal(isUntriaged(testTask({ owner: 'lead', createdBy: 'charlie' }), LEADERS), true);
  });

  it("takes the add of the parent team's lead as the triage on a child team, on any owner there", () => {
    const child = new LeadTree(testConfig(), { team: 'app', id: 'lead' });
    assert.equal(isUntriaged(testTask({ owner: 'lead', createdBy: 'app/lead' }), child), false);
    assert.equal(isUntriaged(testTask({ owner: 'alpha', createdBy: 'app/lead' }), child), false);
    assert.equal(isUntriaged(testTask({ owner: 'alpha', createdBy: 'app/bravo' }), child), true, "a session of the parent team leads no one here");
  });

  it('ends once the task holds a class, whoever added it', () => {
    assert.equal(isUntriaged(testTask({ owner: 'bravo', createdBy: 'bravo', workClass: 'Improvements' }), LEADERS), false);
  });

  it('never holds for a task the park rule takes, as parking needs a stored class', () => {
    const task = parkable({ owner: 'bravo', createdBy: 'bravo' });
    assert.equal(wouldPark(task, input()), true);
    assert.equal(isUntriaged(task, LEADERS), false);
  });
});
