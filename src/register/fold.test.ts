import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_VERSION, type RegisterEvent, type TaskFields } from './events.ts';
import { foldEvents, type Task } from './fold.ts';
import type { TaskStatus } from './model.ts';

const FIELDS: TaskFields = { title: 'Ship it', owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null };

const at = (hour: number): string => `2030-01-07T${String(hour).padStart(2, '0')}:00:00.000Z`;

function create(hour: number): RegisterEvent {
  return { v: EVENT_VERSION, type: 'create', id: 'T1', at: at(hour), by: 'lead', task: FIELDS };
}

function status(hour: number, value: TaskStatus): RegisterEvent {
  return { v: EVENT_VERSION, type: 'status', id: 'T1', at: at(hour), by: 'alpha', status: value, note: 'n', evidence: null, skill: null };
}

function update(hour: number, changes: Partial<TaskFields>): RegisterEvent {
  return { v: EVENT_VERSION, type: 'update', id: 'T1', at: at(hour), by: 'lead', changes, note: null };
}

function taskAfter(events: readonly RegisterEvent[]): Task {
  const task = foldEvents(events).tasks.get('T1');
  assert.ok(task !== undefined);
  return task;
}

describe('foldEvents: when a task took its status and priority', () => {
  it('starts both at the creation', () => {
    const task = taskAfter([create(9)]);
    assert.deepEqual([task.statusAt, task.priorityAt], [at(9), at(9)]);
  });

  it('moves statusAt on a new status only, never on a repeat of the same one', () => {
    assert.equal(taskAfter([create(9), status(10, 'in-progress')]).statusAt, at(10));
    assert.equal(taskAfter([create(9), status(10, 'in-progress'), status(11, 'in-progress')]).statusAt, at(10));
    assert.equal(taskAfter([create(9), status(10, 'blocked'), status(12, 'open')]).statusAt, at(12));
  });

  it('moves priorityAt on a changed priority only, never on other changes or the same priority', () => {
    assert.equal(taskAfter([create(9), update(10, { priority: 1 })]).priorityAt, at(10));
    assert.equal(taskAfter([create(9), update(10, { priority: 2 })]).priorityAt, at(9));
    assert.equal(taskAfter([create(9), update(10, { due: '2030-01-09' }), status(11, 'in-progress')]).priorityAt, at(9));
  });
});
