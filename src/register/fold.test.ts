import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_CARD } from '../testing/card.ts';
import type { DecisionCard } from './card.ts';
import { EVENT_VERSION, type ApprovalVerdict, type RegisterEvent, type TaskFields } from './events.ts';
import { foldEvents, RegisterFold, type Task } from './fold.ts';
import type { TaskStatus } from './model.ts';
import type { ProblemReview } from './review.ts';
import type { WaitReason } from './waits.ts';

const FIELDS: TaskFields = { title: 'Ship it', description: null, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null, after: [], size: null, kind: null, pin: null };

const at = (hour: number): string => `2030-01-07T${String(hour).padStart(2, '0')}:00:00.000Z`;

function create(hour: number): RegisterEvent {
  return { v: EVENT_VERSION, type: 'create', id: 'T1', at: at(hour), by: 'lead', task: FIELDS };
}

function status(hour: number, value: TaskStatus, waits?: readonly WaitReason[]): RegisterEvent {
  const event: RegisterEvent = { v: EVENT_VERSION, type: 'status', id: 'T1', at: at(hour), by: 'alpha', status: value, note: 'n', evidence: null, skill: null };
  return waits === undefined ? event : { ...event, waits };
}

function update(hour: number, changes: Partial<TaskFields>): RegisterEvent {
  return { v: EVENT_VERSION, type: 'update', id: 'T1', at: at(hour), by: 'lead', changes, note: null };
}

function noted(hour: number, by: string, note: string, changes: Partial<TaskFields> = {}): RegisterEvent {
  return { v: EVENT_VERSION, type: 'update', id: 'T1', at: at(hour), by, changes, note };
}

function taskAfter(events: readonly RegisterEvent[]): Task {
  const task = foldEvents(events).tasks.get('T1');
  assert.ok(task !== undefined);
  return task;
}

describe('foldEvents: the note a task shows', () => {
  it("takes an update's note from the task's owner, as a restated set note", () => {
    assert.equal(taskAfter([create(9), status(10, 'waiting'), noted(11, 'alpha', 'restated')]).note, 'restated');
  });

  it('keeps it on a note from another session, and on an update with no note', () => {
    assert.equal(taskAfter([create(9), status(10, 'waiting'), noted(11, 'lead', 'owner decided: yes')]).note, 'n');
    assert.equal(taskAfter([create(9), status(10, 'waiting'), noted(11, 'bravo', 'context')]).note, 'n');
    assert.equal(taskAfter([create(9), status(10, 'waiting'), update(11, { priority: 1 })]).note, 'n');
  });

  it('takes the note of an owner who hands the task over in the same update', () => {
    const task = taskAfter([create(9), status(10, 'in-progress'), noted(11, 'alpha', 'bravo takes the docs', { owner: 'bravo' })]);
    assert.deepEqual([task.owner, task.note], ['bravo', 'bravo takes the docs']);
  });
});

describe('foldEvents: when a task took its status and priority', () => {
  it('starts both at the creation', () => {
    const task = taskAfter([create(9)]);
    assert.deepEqual([task.statusAt, task.priorityAt], [at(9), at(9)]);
  });

  it('moves statusAt on a new status only, never on a repeat of the same one', () => {
    assert.equal(taskAfter([create(9), status(10, 'in-progress')]).statusAt, at(10));
    assert.equal(taskAfter([create(9), status(10, 'in-progress'), status(11, 'in-progress')]).statusAt, at(10));
    assert.equal(taskAfter([create(9), status(10, 'waiting'), status(12, 'open')]).statusAt, at(12));
  });

  it('moves priorityAt on a changed priority only, never on other changes or the same priority', () => {
    assert.equal(taskAfter([create(9), update(10, { priority: 1 })]).priorityAt, at(10));
    assert.equal(taskAfter([create(9), update(10, { priority: 2 })]).priorityAt, at(9));
    assert.equal(taskAfter([create(9), update(10, { due: '2030-01-09' }), status(11, 'in-progress')]).priorityAt, at(9));
  });
});

describe('foldEvents: what a waiting task waits for, and when it started', () => {
  const OWNER: readonly WaitReason[] = [{ kind: 'decision', who: 'owner' }];

  it('keeps the reasons of the latest waiting or verifying status, and clears them on any other', () => {
    const later: readonly WaitReason[] = [{ kind: 'task', id: 'T2' }];
    assert.deepEqual(taskAfter([create(9), status(10, 'waiting', OWNER)]).waits, OWNER);
    assert.deepEqual(taskAfter([create(9), status(10, 'waiting', OWNER), status(11, 'waiting', later)]).waits, later);
    assert.deepEqual(taskAfter([create(9), status(10, 'waiting', OWNER), status(11, 'in-progress')]).waits, []);
    assert.deepEqual(taskAfter([create(9), status(10, 'waiting')]).waits, [], 'a line from before reasons has none');
    assert.deepEqual(taskAfter([create(9), status(10, 'verifying', later)]).waits, later, 'a verifying task keeps what its proof waits for');
    assert.deepEqual(taskAfter([create(9), status(10, 'verifying', later), status(11, 'done')]).waits, []);
  });

  it('starts a task at its first in-progress or verifying status, and keeps that time', () => {
    assert.equal(taskAfter([create(9), status(10, 'waiting', OWNER)]).startedAt, null);
    assert.equal(taskAfter([create(9), status(10, 'verifying')]).startedAt, at(10));
    assert.equal(taskAfter([create(9), status(10, 'in-progress'), status(11, 'open'), status(12, 'in-progress')]).startedAt, at(10));
  });

  it('keeps the proof of the latest verifying status, and clears it when the task leaves verifying', () => {
    const verifying = (hour: number, proof?: string): RegisterEvent => ({ ...status(hour, 'verifying'), ...(proof === undefined ? {} : { proof }) });
    assert.equal(taskAfter([create(9), verifying(10, 'the nightly run')]).proof, 'the nightly run');
    assert.equal(taskAfter([create(9), verifying(10, 'the nightly run'), status(11, 'in-progress')]).proof, null);
    assert.equal(taskAfter([create(9), verifying(10)]).proof, null, 'a line from before --proof has none');
  });

  it('gathers the follow-ups every status change named, each once, in the order first named', () => {
    const closing = (hour: number, value: TaskStatus, followups: readonly string[]): RegisterEvent => ({
      v: EVENT_VERSION,
      type: 'status',
      id: 'T1',
      at: at(hour),
      by: 'alpha',
      status: value,
      note: 'n',
      evidence: null,
      skill: null,
      followups,
    });
    const reopened = [create(9), closing(10, 'verifying', ['T4']), status(11, 'in-progress'), closing(12, 'done', ['T5', 'T4'])];
    assert.deepEqual(taskAfter(reopened).followups, ['T4', 'T5']);
    assert.deepEqual(taskAfter([create(9), closing(10, 'done', [])]).followups, []);
    assert.deepEqual(taskAfter([create(9), status(10, 'done')]).followups, [], 'a line from before --followups names none');
  });

  it("keeps every review part a problem's status changes gave, a later one replacing it", () => {
    const reviewing = (hour: number, value: TaskStatus, review: ProblemReview): RegisterEvent => ({
      v: EVENT_VERSION,
      type: 'status',
      id: 'T1',
      at: at(hour),
      by: 'alpha',
      status: value,
      note: 'n',
      evidence: null,
      skill: null,
      review,
    });
    const events = [
      create(9),
      reviewing(10, 'in-progress', { cause: 'the parser skipped blank rows', how: 'a refactor dropped the guard' }),
      status(11, 'waiting'),
      reviewing(12, 'verifying', { cause: 'the reader skipped blank rows', prevent: 'a spec feeds a blank row' }),
    ];
    assert.deepEqual(taskAfter(events).review, {
      cause: 'the reader skipped blank rows',
      how: 'a refactor dropped the guard',
      prevent: 'a spec feeds a blank row',
    });
    assert.deepEqual(taskAfter([create(9), status(10, 'done')]).review, {}, 'a line from before reviews gives none');
  });

  it('keeps the tasks a task is planned after', () => {
    assert.deepEqual(taskAfter([create(9), update(10, { after: ['T5', 'T6'] })]).after, ['T5', 'T6']);
    assert.deepEqual(taskAfter([create(9), update(10, { after: ['T5'] }), update(11, { after: [] })]).after, []);
  });
});

describe('foldEvents: a pin holds for the owner it was set for (T637)', () => {
  it('clears the pin when the task is handed on, unless the same update pins it', () => {
    assert.equal(taskAfter([create(9), update(10, { pin: 'lead' })]).pin, 'lead');
    assert.equal(taskAfter([create(9), update(10, { pin: 'lead' }), update(11, { owner: 'bravo' })]).pin, null);
    assert.equal(taskAfter([create(9), update(10, { pin: 'lead' }), update(11, { owner: 'bravo', pin: 'lead' })]).pin, 'lead');
    assert.equal(taskAfter([create(9), update(10, { pin: 'lead' }), update(11, { priority: 1 })]).pin, 'lead', 'another change keeps it');
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
    fold.apply(status(11, 'waiting'));
    assert.equal(head.tasks.get('T1')?.status, 'open');
    assert.equal(before.tasks.get('T1')?.status, 'open');
    assert.equal(fold.state().tasks.get('T1')?.status, 'waiting');
  });

  it('keeps the next id of the state it went on from, even with no tasks in it', () => {
    const state = foldEvents([], [], { tasks: new Map(), orphans: 3, nextId: 'T40' });
    assert.deepEqual([state.nextId, state.orphans, state.tasks.size], ['T40', 3, 0]);
  });
});

describe('foldEvents: the decision card', () => {
  const OWNER: readonly WaitReason[] = [{ kind: 'decision', who: 'owner' }];
  const carded = (hour: number, card: DecisionCard): RegisterEvent => ({
    v: EVENT_VERSION,
    type: 'status',
    id: 'T1',
    at: at(hour),
    by: 'alpha',
    status: 'waiting',
    note: 'n',
    evidence: null,
    skill: null,
    waits: OWNER,
    card,
  });

  it("keeps the latest waiting status's card, and drops it when the task leaves waiting", () => {
    const later: DecisionCard = { ...TEST_CARD, recommend: 'Pro, since the launch is late' };
    assert.deepEqual(taskAfter([create(9), carded(10, TEST_CARD)]).card, TEST_CARD);
    assert.deepEqual(taskAfter([create(9), carded(10, TEST_CARD), carded(11, later)]).card, later);
    assert.equal(taskAfter([create(9), carded(10, TEST_CARD), status(11, 'in-progress')]).card, null);
    assert.equal(taskAfter([create(9), status(10, 'waiting', OWNER)]).card, null, 'a line from before cards has none');
  });
});

function answered(hour: number, verdict: ApprovalVerdict, note = 'tests green'): RegisterEvent {
  return { v: EVENT_VERSION, type: 'update', id: 'T1', at: at(hour), by: 'lead', changes: {}, note, verdict };
}

describe("foldEvents: the lead's answer to an approval (T684)", () => {
  const asked = [create(9), status(10, 'waiting', [{ kind: 'approval', who: 'lead' }])];

  it('holds the answer with who gave it, when and its note, and keeps the note the task shows', () => {
    const task = taskAfter([...asked, answered(11, 'approved')]);
    assert.deepEqual(task.answer, { verdict: 'approved', by: 'lead', at: at(11), note: 'tests green' });
    assert.equal(task.note, 'n');
  });

  it('takes the latest answer and keeps it through an update without one', () => {
    const task = taskAfter([...asked, answered(11, 'declined', 'no tests'), answered(12, 'approved'), update(13, { priority: 1 })]);
    assert.deepEqual([task.answer?.verdict, task.answer?.at], ['approved', at(12)]);
  });

  it('clears it on the next status change, so an approval covers only what was asked', () => {
    assert.equal(taskAfter([create(9)]).answer, null);
    assert.equal(taskAfter([...asked, answered(11, 'approved'), status(12, 'verifying')]).answer, null);
    assert.equal(taskAfter([...asked, answered(11, 'approved'), status(12, 'waiting', [{ kind: 'approval', who: 'lead' }])]).answer, null);
  });
});
