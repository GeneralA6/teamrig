import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_VERSION, type RegisterEvent, type TaskFields } from './events.ts';
import { foldEvents, RegisterFold, type Task } from './fold.ts';
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

describe('RegisterFold: going on from a folded state', () => {
  const T2: TaskFields = { ...FIELDS, title: 'Second', owner: 'bravo' };
  const events: RegisterEvent[] = [
    create(9),
    { v: EVENT_VERSION, type: 'create', id: 'T2', at: at(10), by: 'bravo', task: T2 },
    status(11, 'in-progress'),
    { v: EVENT_VERSION, type: 'status', id: 'T7', at: at(12), by: 'alpha', status: 'open', note: null, evidence: null, skill: null },
    update(13, { priority: 1, owner: 'bravo' }),
    { v: EVENT_VERSION, type: 'create', id: 'T2', at: at(14), by: 'lead', task: FIELDS },
    status(15, 'done'),
  ];

  it('gives the full replay whatever event it resumes after', () => {
    const full = foldEvents(events, ['T4']);
    for (let split = 0; split <= events.length; split += 1) {
      const head = foldEvents(events.slice(0, split), ['T4']);
      assert.deepEqual(foldEvents(events.slice(split), [], head), full, `resumed after ${split} event(s)`);
    }
  });

  it('says which events applied and counts the rest as orphans', () => {
    const fold = new RegisterFold();
    assert.deepEqual(
      events.map((event) => fold.apply(event)),
      [true, true, true, false, true, false, true],
    );
    assert.equal(fold.state().orphans, 2);
    assert.equal(fold.state().nextId, 'T8', 'the orphan id stays reserved');
  });

  it('never changes the state it went on from, nor a state it already handed out', () => {
    const head = foldEvents(events.slice(0, 2));
    const fold = new RegisterFold(head);
    const before = fold.state();
    fold.apply(status(11, 'blocked'));
    assert.equal(head.tasks.get('T1')?.status, 'open');
    assert.equal(before.tasks.get('T1')?.status, 'open');
    assert.equal(fold.state().tasks.get('T1')?.status, 'blocked');
  });

  it('keeps the next id of the state it went on from, even with no tasks in it', () => {
    const state = foldEvents([], [], { tasks: new Map(), orphans: 3, nextId: 'T40' });
    assert.deepEqual([state.nextId, state.orphans, state.tasks.size], ['T40', 3, 0]);
  });
});
