import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_CARD } from '../testing/card.ts';
import type { DecisionCard } from './card.ts';
import { EVENT_VERSION, type ApprovalVerdict, type RegisterEvent, type TaskFields } from './events.ts';
import { foldEvents, RegisterFold, type Task } from './fold.ts';
import type { TaskStatus } from './model.ts';
import type { ProblemReview } from './review.ts';
import type { WaitReason } from './waits.ts';

const FIELDS: TaskFields = { title: 'Ship it', description: null, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null };

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

describe('foldEvents: the size base OVER-SIZE counts from (T649)', () => {
  const base = { day: '2030-01-07', w: 12_000_000 };
  const resized = (hour: number, size: number | null): RegisterEvent => ({ ...update(hour, { size }), ...(size === null ? {} : { sizeBase: base }) });

  it('starts with none, even on a task created with a size', () => {
    assert.equal(taskAfter([{ v: EVENT_VERSION, type: 'create', id: 'T1', at: at(9), by: 'lead', task: { ...FIELDS, size: 1 } }]).sizeBase, null);
  });

  it('takes the base of an update that gives a size, and keeps it through other updates', () => {
    assert.deepEqual(taskAfter([create(9), resized(10, 0.5)]).sizeBase, base);
    assert.deepEqual(taskAfter([create(9), resized(10, 0.5), update(11, { priority: 1 }), status(12, 'in-progress')]).sizeBase, base);
  });

  it('drops it when the size is cleared, or given by a line with no base', () => {
    assert.equal(taskAfter([create(9), resized(10, 0.5), resized(11, null)]).sizeBase, null);
    assert.equal(taskAfter([create(9), resized(10, 0.5), update(11, { size: 2 })]).sizeBase, null, 'a teamrig before T649 sized it: all spend counts');
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

describe('foldEvents: the sighting a done task is watched for (T1306)', () => {
  const watched: RegisterEvent = { v: EVENT_VERSION, type: 'status', id: 'T1', at: at(10), by: 'alpha', status: 'done', note: 'n', evidence: 'abc1234', skill: 'none', watch: 'the row shows' };

  it('keeps the watch of the done line that closed it, and none for a task never watched', () => {
    assert.equal(taskAfter([create(9), watched]).watch, 'the row shows');
    assert.equal(taskAfter([create(9), status(10, 'done')]).watch, null);
  });

  it('clears it when set done again without one, or reopened', () => {
    assert.equal(taskAfter([create(9), watched, status(11, 'done')]).watch, null);
    assert.equal(taskAfter([create(9), watched, status(11, 'in-progress')]).watch, null);
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

  it('counts a re-park only when a verifying task with waits names other waits, and starts again on any other status', () => {
    const night: readonly WaitReason[] = [{ kind: 'time', at: '2030-01-08 02:00' }];
    const nextNight: readonly WaitReason[] = [{ kind: 'time', at: '2030-01-09 02:00' }];
    const run: readonly WaitReason[] = [{ kind: 'task', id: 'T2' }];
    assert.equal(taskAfter([create(9), status(10, 'verifying', night)]).reparks, 0, 'a first park is not a re-park');
    assert.equal(taskAfter([create(9), status(10, 'verifying'), status(11, 'verifying', night)]).reparks, 0, 'naming its first waits is not a re-park');
    assert.equal(taskAfter([create(9), status(10, 'verifying', night), status(11, 'verifying', night)]).reparks, 0, 'the same waits again');
    assert.equal(taskAfter([create(9), status(10, 'verifying', [...night, ...run]), status(11, 'verifying', run)]).reparks, 0, 'a cleared wait dropped');
    const twice = [create(9), status(10, 'verifying', night), status(11, 'verifying', nextNight), status(12, 'verifying', run)];
    assert.equal(taskAfter(twice).reparks, 2);
    assert.equal(taskAfter([...twice, status(13, 'in-progress')]).reparks, 0);
    assert.equal(taskAfter([...twice, status(13, 'in-progress'), status(14, 'verifying', night)]).reparks, 0);
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

  it("keeps every review part a bug's status changes gave, a later one replacing it", () => {
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
    const state = foldEvents([], [], { tasks: new Map(), orphans: 3, nextId: 'T40', moved: new Map() });
    assert.deepEqual([state.nextId, state.orphans, state.tasks.size], ['T40', 3, 0]);
  });
});

function moved(hour: number, to: string, id = 'T1'): RegisterEvent {
  return { v: EVENT_VERSION, type: 'moved', id, at: at(hour), by: 'lead', to };
}

describe('foldEvents: a task that moved to another team (T1144)', () => {
  it('takes the task out and records the team it went to', () => {
    const state = foldEvents([create(9), status(10, 'in-progress'), moved(11, 'web')]);
    assert.deepEqual([state.tasks.size, [...state.moved], state.orphans, state.nextId], [0, [['T1', 'web']], 0, 'T2']);
  });

  it('counts any later event on the id as an orphan, a create too', () => {
    const fold = new RegisterFold();
    assert.deepEqual(
      [create(9), moved(10, 'web'), status(11, 'done'), update(12, { priority: 1 }), create(13), moved(14, 'ops')].map((event) => fold.apply(event)),
      [true, true, false, false, false, false],
    );
    assert.deepEqual([fold.state().tasks.size, fold.state().orphans, fold.state().moved.get('T1')], [0, 4, 'web']);
  });

  it('counts a moved line naming no task as an orphan, and records no move', () => {
    const state = foldEvents([moved(9, 'web', 'T5')]);
    assert.deepEqual([state.orphans, state.moved.size, state.nextId], [1, 0, 'T6']);
  });

  it('gives the full replay whatever event it resumes after, and never changes a state it handed out', () => {
    const events = [create(9), { ...create(10), id: 'T2' }, moved(11, 'web'), status(12, 'done'), moved(13, 'ops', 'T2')];
    const full = foldEvents(events);
    for (let split = 0; split <= events.length; split += 1) {
      assert.deepEqual(foldEvents(events.slice(split), [], foldEvents(events.slice(0, split))), full, `resumed after ${split} event(s)`);
    }
    const head = foldEvents(events.slice(0, 3));
    const fold = new RegisterFold(head);
    fold.apply(moved(13, 'ops', 'T2'));
    assert.deepEqual([[...head.moved.keys()], [...fold.state().moved.keys()]], [['T1'], ['T1', 'T2']]);
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

function later(hour: number, waits: readonly WaitReason[], by = 'lead'): RegisterEvent {
  return { v: EVENT_VERSION, type: 'update', id: 'T1', at: at(hour), by, changes: {}, note: 'after the demo', waits };
}

describe('foldEvents: the waits a Later gives a task (T1295)', () => {
  const OWNER: readonly WaitReason[] = [{ kind: 'decision', who: 'owner' }];
  const PUT_OFF: readonly WaitReason[] = [...OWNER, { kind: 'time', at: '2030-01-09 12:00' }];

  it("replaces a waiting or verifying task's waits, keeping its status, when it took it and the note it shows", () => {
    const task = taskAfter([create(9), status(10, 'waiting', OWNER), later(11, PUT_OFF)]);
    assert.deepEqual([task.waits, task.status, task.statusAt, task.note], [PUT_OFF, 'waiting', at(10), 'n']);
    assert.deepEqual(taskAfter([create(9), status(10, 'verifying', OWNER), later(11, PUT_OFF)]).waits, PUT_OFF);
    assert.deepEqual(taskAfter([create(9), status(10, 'waiting', PUT_OFF), later(11, OWNER)]).waits, OWNER, 'a Later brought back drops its time');
  });

  it('means nothing on a task in any other status, and a status set after it clears its waits as any', () => {
    assert.deepEqual(taskAfter([create(9), status(10, 'in-progress'), later(11, PUT_OFF)]).waits, []);
    assert.deepEqual(taskAfter([create(9), later(10, PUT_OFF)]).waits, [], 'an open task');
    assert.deepEqual(taskAfter([create(9), status(10, 'waiting', OWNER), later(11, PUT_OFF), status(12, 'in-progress')]).waits, []);
  });

  it('keeps the waits through an update that names none', () => {
    assert.deepEqual(taskAfter([create(9), status(10, 'waiting', OWNER), later(11, PUT_OFF), update(12, { priority: 1 })]).waits, PUT_OFF);
  });
});

function decided(hour: number, waits: readonly WaitReason[]): RegisterEvent {
  return { v: EVENT_VERSION, type: 'update', id: 'T1', at: at(hour), by: 'lead', changes: {}, note: 'owner decided: ship it', waits, decided: true };
}

describe("foldEvents: the owner's decision a leader records (T1366)", () => {
  const OWNER: readonly WaitReason[] = [{ kind: 'decision', who: 'owner' }];

  it('drops the owner wait and marks the task decided, keeping its status and the note it shows', () => {
    const task = taskAfter([create(9), status(10, 'waiting', OWNER), decided(11, [])]);
    assert.deepEqual([task.waits, task.status, task.note], [[], 'waiting', 'n']);
    assert.deepEqual(task.decided, { by: 'lead', at: at(11), note: 'owner decided: ship it' });
  });

  it('means nothing outside a wait status, and the next status clears it', () => {
    assert.equal(taskAfter([create(9), status(10, 'in-progress'), decided(11, [])]).decided, null);
    assert.equal(taskAfter([create(9), status(10, 'waiting', OWNER), decided(11, []), status(12, 'in-progress')]).decided, null);
    assert.equal(taskAfter([create(9), status(10, 'waiting', OWNER), later(11, OWNER)]).decided, null, 'a Later is no decision');
  });
});
