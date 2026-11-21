import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretScanner } from '../core/secrets.ts';
import { TASK_LINE_VERSION, type CreateEvent, type MovedEvent, type RegisterEvent, type StatusEvent, type TaskFields, type UpdateEvent } from '../register/events.ts';
import { cutText, eventKeyOf, historyBody, type Connector, type HistoryBody, type ServedEvent, type SourceNames } from './index.ts';

/** A text the shipped shapes take for a secret, built here so no secret-shaped line sits in the repository. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');

/** A tracker whose refs are `tr:<item>` and whose import writes the source `tracker`. */
const TRACKER: Connector = {
  id: 'tracker',
  name: 'Tracker',
  itemOf: (ref) => (ref.startsWith('tr:') ? { id: ref.slice(3), url: `https://tracker.example/item/${ref.slice(3)}` } : undefined),
};

const SESSION_NAMES = new Map([
  ['lead', 'app-lead'],
  ['alpha', 'app-alpha'],
]);

const NAMES: SourceNames = { owner: 'owner', connectors: [TRACKER], nameOf: (session) => SESSION_NAMES.get(session) };

const HEAD = { v: TASK_LINE_VERSION, id: 'T1', at: '2030-01-07T09:00:00.000Z', by: 'lead' };

function fields(changes: Partial<TaskFields> = {}): TaskFields {
  return {
    title: 'First',
    description: null,
    owner: 'alpha',
    source: 'lead',
    ref: null,
    priority: 2,
    due: null,
    goals: [],
    noGoal: false,
    week: null,
    after: [],
    size: null,
    type: null,
    critical: false,
    pin: null,
    workClass: null,
    prepares: null,
    ...changes,
  };
}

function create(task: Partial<TaskFields> = {}): CreateEvent {
  return { ...HEAD, type: 'create', task: fields(task) };
}

function status(more: Partial<StatusEvent> = {}): StatusEvent {
  return { ...HEAD, at: '2030-01-07T10:00:00.000Z', by: 'alpha', type: 'status', status: 'open', note: null, evidence: null, skill: null, ...more };
}

function update(changes: Partial<TaskFields>, more: Partial<UpdateEvent> = {}): UpdateEvent {
  return { ...HEAD, at: '2030-01-07T11:00:00.000Z', type: 'update', changes, note: null, ...more };
}

function bodyOf(...events: RegisterEvent[]): HistoryBody {
  return historyBody({ task: 'T1', events, shapes: new SecretScanner(), connectors: [TRACKER], names: NAMES });
}

function at(body: HistoryBody, place: number): ServedEvent {
  const event = body.events[place];
  assert.ok(event !== undefined, `event ${place} is served`);
  return event;
}

function shapeOfSecret(): string {
  const shape = new SecretScanner().find(SECRET)?.description;
  assert.ok(shape !== undefined, 'the shipped shapes know the test secret');
  return shape;
}

describe('historyBody', () => {
  it('serves a create event with the fields the tasks document serves of a task, and no other', () => {
    const body = bodyOf(
      create({
        description: 'Why it matters',
        priority: 1,
        type: 'bug',
        critical: true,
        due: '2030-01-09 16:00',
        ref: 'tr:acme/app#12',
        goals: ['A1'],
        week: '2030-01-07',
        size: 1.5,
        pin: 'lead',
        workClass: 'roadmap',
        after: ['T7'],
        noGoal: true,
        prepares: { goal: 'A1', slice: 2 },
      }),
    );
    assert.deepEqual(body, {
      task: 'T1',
      events: [
        {
          kind: 'create',
          at: '2030-01-07T09:00:00.000Z',
          by: 'lead',
          task: {
            title: { text: 'First', source: 'team' },
            description: { text: 'Why it matters', source: 'team' },
            owner: 'alpha',
            priority: 1,
            type: 'bug',
            critical: true,
            due: '2030-01-09 16:00',
            source: { kind: 'session', id: 'lead', name: 'app-lead' },
            ref: {
              text: 'tr:acme/app#12',
              connector: { id: 'tracker', name: 'Tracker' },
              id: 'acme/app#12',
              label: { text: 'acme/app#12', source: 'outside' },
              url: 'https://tracker.example/item/acme/app#12',
            },
            goals: ['A1'],
            week: '2030-01-07',
            size: 1.5,
            pin: 'lead',
            workClass: 'roadmap',
            after: ['T7'],
          },
        },
      ],
      cuts: [],
    });
  });

  it('serves a status event with what its status wrote, and null for what it did not', () => {
    const body = bodyOf(
      create(),
      status({ status: 'in-progress', met: 'T7 ran green', oneCommit: true }),
      status({
        status: 'verifying',
        note: 'shipped',
        proof: 'the nightly run is green',
        waits: [
          { kind: 'time', at: '2030-01-08 22:10' },
          { kind: 'task', id: 'T9' },
        ],
        followups: ['T12'],
      }),
      status({ status: 'done', note: 'ran live', evidence: 'commit abc1234', skill: 'none', watch: 'the next roll', waits: [], followups: [] }),
    );
    assert.deepEqual(at(body, 1), {
      kind: 'status',
      at: '2030-01-07T10:00:00.000Z',
      by: 'alpha',
      status: 'in-progress',
      note: null,
      evidence: null,
      skill: null,
      proof: null,
      watch: null,
      met: 'T7 ran green',
      oneCommit: true,
      waits: null,
      followups: null,
    });
    assert.deepEqual(at(body, 2), {
      kind: 'status',
      at: '2030-01-07T10:00:00.000Z',
      by: 'alpha',
      status: 'verifying',
      note: 'shipped',
      evidence: null,
      skill: null,
      proof: 'the nightly run is green',
      watch: null,
      met: null,
      oneCommit: false,
      waits: [
        { kind: 'time', at: '2030-01-08 22:10' },
        { kind: 'task', id: 'T9' },
      ],
      followups: ['T12'],
    });
    assert.deepEqual(at(body, 3), {
      kind: 'status',
      at: '2030-01-07T10:00:00.000Z',
      by: 'alpha',
      status: 'done',
      note: 'ran live',
      evidence: 'commit abc1234',
      skill: 'none',
      proof: null,
      watch: 'the next roll',
      met: null,
      oneCommit: false,
      waits: [],
      followups: [],
    });
  });

  it('serves an update with only the fields it gave: absent was left as it was, null was cleared', () => {
    const body = bodyOf(create({ due: '2030-01-09', description: 'Old' }), update({ due: null, description: null, priority: 1 }, { note: 'the owner moved it up' }));
    assert.deepEqual(at(body, 1), {
      kind: 'update',
      at: '2030-01-07T11:00:00.000Z',
      by: 'lead',
      changes: { description: null, priority: 1, due: null },
      note: 'the owner moved it up',
      verdict: null,
      waits: null,
      decided: false,
    });
  });

  it('serves every field an update can give, in the forms a create event serves them', () => {
    const changes = fields({ title: 'Second', description: 'New', owner: 'bravo', ref: 'plain ref', goals: ['B1'], after: ['T3'], pin: 'lead', week: '2030-01-14', size: 2, type: 'task', workClass: 'improvements' });
    const [served] = bodyOf(update(changes)).events;
    assert.ok(served?.kind === 'update');
    assert.deepEqual(served.changes, {
      title: { text: 'Second', source: 'team' },
      description: { text: 'New', source: 'team' },
      owner: 'bravo',
      priority: 2,
      type: 'task',
      critical: false,
      due: null,
      source: { kind: 'session', id: 'lead', name: 'app-lead' },
      ref: { text: 'plain ref', connector: null, id: null, label: null, url: null },
      goals: ['B1'],
      week: '2030-01-14',
      size: 2,
      pin: 'lead',
      workClass: 'improvements',
      after: ['T3'],
    });
  });

  it('serves a leader’s answer, a decision and the waits an update left, and none of what a later minor serves', () => {
    const body = bodyOf(
      create(),
      update({}, { verdict: 'declined', note: 'not before the audit' }),
      update({ noGoal: true, prepares: { goal: 'A1', slice: 2 } }, { decided: true, note: 'the owner picked B', waits: [{ kind: 'approval', who: 'lead' }], sizeBase: { day: '2030-01-07', w: 12 } }),
    );
    assert.deepEqual(at(body, 1), { kind: 'update', at: '2030-01-07T11:00:00.000Z', by: 'lead', changes: {}, note: 'not before the audit', verdict: 'declined', waits: null, decided: false });
    assert.deepEqual(at(body, 2), {
      kind: 'update',
      at: '2030-01-07T11:00:00.000Z',
      by: 'lead',
      changes: {},
      note: 'the owner picked B',
      verdict: null,
      waits: [{ kind: 'approval', who: 'lead' }],
      decided: true,
    });
  });

  it('serves a move to another team as where the task went', () => {
    const moved: MovedEvent = { ...HEAD, at: '2030-01-07T12:00:00.000Z', type: 'moved', to: 'web' };
    assert.deepEqual(at(bodyOf(create(), moved), 1), { kind: 'moved', at: '2030-01-07T12:00:00.000Z', by: 'lead', to: 'web' });
  });

  it('marks the title and description of a tracker import as outside text and escapes their control characters', () => {
    const [served] = bodyOf(create({ source: 'tracker', title: 'Fix \u001b[31mlogin', description: 'steps‮ reversed' })).events;
    assert.ok(served?.kind === 'create');
    assert.equal(served.task.title.source, 'outside');
    assert.ok(!served.task.title.text.includes('\u001b'));
    assert.equal(served.task.description?.source, 'outside');
    assert.equal(served.task.description?.text.includes('‮'), false);
    assert.deepEqual(served.task.source, { kind: 'connector', id: 'tracker', name: 'Tracker' });
  });

  it('marks an update’s title by the source the task has once the update is written', () => {
    const body = bodyOf(
      create({ source: 'owner' }),
      update({ title: 'Ours' }),
      update({ title: 'Theirs', source: 'tracker' }),
      status({ status: 'in-progress' }),
      update({ description: 'Still theirs' }),
      update({ title: 'Ours again', source: 'alpha' }),
    );
    const marks = body.events.map((event) => (event.kind === 'update' ? [event.changes.title?.source ?? null, event.changes.description?.source ?? null] : null));
    assert.deepEqual(marks, [null, ['team', null], ['outside', null], null, [null, 'outside'], ['team', null]]);
    const [created, , sourced] = body.events;
    assert.ok(created?.kind === 'create' && sourced?.kind === 'update');
    assert.deepEqual(created.task.source, { kind: 'owner', id: 'owner', name: 'owner' });
    assert.deepEqual(sourced.changes.source, { kind: 'connector', id: 'tracker', name: 'Tracker' });
  });

  it('marks outside the texts of a history with no create event, whose source is not known', () => {
    const [served] = bodyOf(update({ title: 'Whose?', description: 'No one says' })).events;
    assert.ok(served?.kind === 'update');
    assert.deepEqual([served.changes.title?.source, served.changes.description?.source], ['outside', 'outside']);
  });

  it('cuts each text shaped like a secret, and names the event by its task and its place', () => {
    const shape = shapeOfSecret();
    const body = bodyOf(
      create({ title: SECRET, description: `see ${SECRET}`, ref: SECRET }),
      status({ status: 'done', note: SECRET, evidence: SECRET, skill: SECRET, proof: SECRET, watch: SECRET, met: SECRET }),
      update({ title: SECRET, description: SECRET, ref: SECRET }, { note: SECRET }),
    );
    assert.deepEqual(body.cuts, [
      { id: 'T1#0', field: 'task.title', shape },
      { id: 'T1#0', field: 'task.description', shape },
      { id: 'T1#0', field: 'ref', shape },
      { id: 'T1#1', field: 'note', shape },
      { id: 'T1#1', field: 'evidence', shape },
      { id: 'T1#1', field: 'skill', shape },
      { id: 'T1#1', field: 'proof', shape },
      { id: 'T1#1', field: 'watch', shape },
      { id: 'T1#1', field: 'met', shape },
      { id: 'T1#2', field: 'changes.title', shape },
      { id: 'T1#2', field: 'changes.description', shape },
      { id: 'T1#2', field: 'ref', shape },
      { id: 'T1#2', field: 'note', shape },
    ]);
    const [created, , updated] = body.events;
    assert.ok(created?.kind === 'create' && updated?.kind === 'update');
    assert.equal(created.task.title.text, cutText(shape));
    assert.deepEqual(created.task.ref, { text: cutText(shape), connector: null, id: null, label: null, url: null });
    assert.equal(updated.note, cutText(shape));
    assert.ok(!JSON.stringify(body).includes(SECRET));
  });

  it('cuts a session’s name shaped like a secret where an event names the source', () => {
    const shape = shapeOfSecret();
    const names: SourceNames = { ...NAMES, nameOf: () => SECRET };
    const body = historyBody({ task: 'T1', events: [create()], shapes: new SecretScanner(), connectors: [TRACKER], names });
    assert.deepEqual(body.cuts, [{ id: 'T1#0', field: 'source.name', shape }]);
  });

  it('serves no event of a task the register holds none of', () => {
    assert.deepEqual(bodyOf(), { task: 'T1', events: [], cuts: [] });
  });
});

describe('eventKeyOf', () => {
  it('names an event by its task and its place in the history, counted from 0', () => {
    assert.equal(eventKeyOf('T5', 3), 'T5#3');
  });
});
