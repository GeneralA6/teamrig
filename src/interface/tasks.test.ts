import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretScanner } from '../core/secrets.ts';
import type { Task } from '../register/fold.ts';
import { testTask } from '../testing/task.ts';
import { cutText, tasksBody, type Connector, type ServedTask, type SourceNames, type TasksBody } from './index.ts';

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

/** Every field a served task has, in the order the document writes them: the contract of interface 1.0, then 1.6's. */
const SERVED_FIELDS = [
  'id',
  'title',
  'description',
  'owner',
  'priority',
  'type',
  'critical',
  'due',
  'status',
  'note',
  'proof',
  'evidence',
  'skill',
  'statusAt',
  'source',
  'ref',
  'goals',
  'week',
  'size',
  'pin',
  'workClass',
  'createdBy',
  'createdAt',
  'updatedAt',
  'updatedBy',
  'priorityAt',
  'assignedAt',
  'ownerSeenAt',
  'waits',
  'answer',
  'decided',
  'after',
  'card',
  'descriptionCut',
  'sizeBase',
  'prepares',
  'noGoal',
  'startedAt',
  'waitsAt',
];

function bodyOf(tasks: readonly Task[], owner: string | null = null): TasksBody {
  return tasksBody({ tasks, owner, shapes: new SecretScanner(), connectors: [TRACKER], names: NAMES });
}

function only(body: TasksBody): ServedTask {
  const [task, ...rest] = body.tasks;
  assert.ok(task !== undefined);
  assert.deepEqual(rest, []);
  return task;
}

function secretShape(): string {
  const shape = new SecretScanner().find(SECRET)?.description;
  assert.ok(shape !== undefined);
  return shape;
}

describe('the tasks document', () => {
  it('serves exactly the fields of the contract, and none of the register-only ones', () => {
    const task = only(bodyOf([testTask({ watch: 'the next run', reparks: 2, followups: ['T9'] })]));

    assert.deepEqual(Object.keys(task), SERVED_FIELDS);
  });

  it('serves a team task as written', () => {
    const task = only(
      bodyOf([
        testTask({
          id: 'T7',
          description: 'what\nand why',
          ref: 'src/cli/run.ts:136',
          due: '2030-01-09 12:00',
          goals: ['g1', 'g2'],
          week: '2030-01-07',
          size: 1.5,
          type: 'bug',
          critical: true,
          pin: 'lead',
          workClass: 'roadmap',
          after: ['T5', 'T6'],
          ownerSeenAt: '2030-01-07T09:30:00.000Z',
        }),
      ]),
    );

    assert.deepEqual(task, {
      id: 'T7',
      title: { text: 'Add a health check', source: 'team' },
      description: { text: 'what\nand why', source: 'team' },
      owner: 'alpha',
      priority: 2,
      type: 'bug',
      critical: true,
      due: '2030-01-09 12:00',
      status: 'open',
      note: null,
      proof: null,
      evidence: null,
      skill: null,
      statusAt: '2030-01-07T09:00:00.000Z',
      source: { kind: 'session', id: 'lead', name: 'app-lead' },
      ref: { text: 'src/cli/run.ts:136', connector: null, id: null, label: null, url: null },
      goals: ['g1', 'g2'],
      week: '2030-01-07',
      size: 1.5,
      pin: 'lead',
      workClass: 'roadmap',
      createdBy: 'lead',
      createdAt: '2030-01-07T09:00:00.000Z',
      updatedAt: '2030-01-07T09:00:00.000Z',
      updatedBy: 'lead',
      priorityAt: '2030-01-07T09:00:00.000Z',
      assignedAt: '2030-01-07T09:00:00.000Z',
      ownerSeenAt: '2030-01-07T09:30:00.000Z',
      waits: [],
      answer: null,
      decided: null,
      after: ['T5', 'T6'],
      card: null,
      descriptionCut: null,
      sizeBase: null,
      prepares: null,
      noGoal: false,
      startedAt: null,
      waitsAt: '2030-01-07T09:00:00.000Z',
    });
  });

  it('marks the title and description of a tracker import as outside text and escapes their control characters', () => {
    const task = only(bodyOf([testTask({ source: 'tracker', ref: 'tr:acme/app#12', title: 'Fix \u001b[31mlogin', description: 'steps‮ reversed', note: 'ours\tkept' })]));

    assert.equal(task.title.source, 'outside');
    assert.ok(!task.title.text.includes('\u001b'));
    assert.equal(task.description?.source, 'outside');
    assert.ok(task.description !== null && !task.description.text.includes('‮'));
    assert.deepEqual(task.source, { kind: 'connector', id: 'tracker', name: 'Tracker' });
    assert.deepEqual(task.ref, {
      text: 'tr:acme/app#12',
      connector: { id: 'tracker', name: 'Tracker' },
      id: 'acme/app#12',
      label: { text: 'acme/app#12', source: 'outside' },
      url: 'https://tracker.example/item/acme/app#12',
    });
    assert.equal(task.note, 'ours\tkept');
  });

  it("marks the owner's own task and a past session's as team text", () => {
    const body = bodyOf([testTask({ id: 'T1', source: 'owner' }), testTask({ id: 'T2', source: 'gone' })]);

    assert.deepEqual(
      body.tasks.map((task) => [task.source, task.title.source]),
      [
        [{ kind: 'owner', id: 'owner', name: 'owner' }, 'team'],
        [{ kind: 'session', id: 'gone', name: 'gone' }, 'team'],
      ],
    );
  });

  it('serves the waits, the approval answer and the owner decision as data', () => {
    const task = only(
      bodyOf([
        testTask({
          status: 'waiting',
          note: 'head abc1234',
          waits: [
            { kind: 'approval', who: 'lead' },
            { kind: 'decision', who: 'owner' },
            { kind: 'task', id: 'T5' },
            { kind: 'time', at: '2030-01-09 12:00' },
          ],
          answer: { verdict: 'approved', by: 'lead', at: '2030-01-07T11:00:00.000Z', note: 'read the diff' },
          decided: { by: 'lead', at: '2030-01-07T12:00:00.000Z', note: null },
        }),
      ]),
    );

    assert.deepEqual(task.waits, [
      { kind: 'approval', who: 'lead' },
      { kind: 'decision', who: 'owner' },
      { kind: 'task', id: 'T5' },
      { kind: 'time', at: '2030-01-09 12:00' },
    ]);
    assert.deepEqual(task.answer, { verdict: 'approved', by: 'lead', at: '2030-01-07T11:00:00.000Z', note: 'read the diff' });
    assert.deepEqual(task.decided, { by: 'lead', at: '2030-01-07T12:00:00.000Z', note: null });
  });

  it("serves an owner card's every part, a part it leaves out as null", () => {
    const [full, bare] = bodyOf([
      testTask({
        id: 'T1',
        status: 'waiting',
        waits: [{ kind: 'decision', who: 'owner' }],
        card: {
          question: 'Raise the cap?',
          options: ['1. to 6 GB', '2. keep 4 GB'],
          recommend: '1, the builds wait less',
          byDefault: 'keep 4 GB',
          whyAsk: 'the order named 4 GB',
          gate: 'resource changes',
          run: 'C:/steps/cap.ts',
          affects: 'the cap',
          security: true,
        },
      }),
      testTask({ id: 'T2', status: 'waiting', waits: [{ kind: 'approval', who: 'lead' }], card: { question: 'Merge it?', options: [], recommend: 'yes', byDefault: 'it waits' } }),
    ]).tasks;

    assert.deepEqual(full?.card, {
      question: 'Raise the cap?',
      options: ['1. to 6 GB', '2. keep 4 GB'],
      recommend: '1, the builds wait less',
      byDefault: 'keep 4 GB',
      whyAsk: 'the order named 4 GB',
      gate: 'resource changes',
      run: 'C:/steps/cap.ts',
      affects: 'the cap',
      security: true,
    });
    assert.deepEqual(bare?.card, { question: 'Merge it?', options: [], recommend: 'yes', byDefault: 'it waits', whyAsk: null, gate: null, run: null, affects: null, security: false });
  });

  it('serves the size base, the prep marker, the goal mark, the left-out description and the start and wait times', () => {
    const task = only(
      bodyOf([
        testTask({
          description: null,
          descriptionCut: { chars: 812, hash: '1a2b3c4d' },
          size: 2,
          sizeBase: { day: '2030-01-06', w: 1200 },
          prepares: { goal: 'g1', slice: 2 },
          noGoal: true,
          status: 'waiting',
          startedAt: '2030-01-07T10:00:00.000Z',
          waitsAt: '2030-01-07T11:00:00.000Z',
        }),
      ]),
    );

    assert.equal(task.description, null);
    assert.deepEqual(
      [task.descriptionCut, task.sizeBase, task.prepares, task.noGoal, task.startedAt, task.waitsAt],
      [{ chars: 812, hash: '1a2b3c4d' }, { day: '2030-01-06', w: 1200 }, { goal: 'g1', slice: 2 }, true, '2030-01-07T10:00:00.000Z', '2030-01-07T11:00:00.000Z'],
    );
  });

  it('cuts every free text that matches a secret shape and lists each cut by task and field', () => {
    const shape = secretShape();
    const cut = cutText(shape);
    const body = bodyOf([
      testTask({
        id: 'T3',
        title: SECRET,
        description: `see ${SECRET}`,
        ref: SECRET,
        status: 'verifying',
        note: SECRET,
        proof: SECRET,
        evidence: SECRET,
        skill: SECRET,
        answer: { verdict: 'declined', by: 'lead', at: '2030-01-07T11:00:00.000Z', note: SECRET },
        decided: { by: 'lead', at: '2030-01-07T12:00:00.000Z', note: SECRET },
        card: { question: SECRET, options: ['keep it', SECRET], recommend: SECRET, byDefault: SECRET, whyAsk: SECRET, gate: SECRET, run: SECRET, affects: SECRET },
      }),
    ]);
    const task = only(body);

    assert.ok(!JSON.stringify(body).includes('hunter2'));
    assert.equal(task.title.text, cut);
    assert.equal(task.description?.text, cut);
    assert.deepEqual(task.ref, { text: cut, connector: null, id: null, label: null, url: null });
    assert.deepEqual([task.note, task.proof, task.evidence, task.skill, task.answer?.note, task.decided?.note], [cut, cut, cut, cut, cut, cut]);
    assert.deepEqual(task.card, { question: cut, options: ['keep it', cut], recommend: cut, byDefault: cut, whyAsk: cut, gate: cut, run: cut, affects: cut, security: false });
    assert.deepEqual(
      body.cuts,
      [
        'title',
        'description',
        'note',
        'proof',
        'evidence',
        'skill',
        'ref',
        'answer.note',
        'decided.note',
        'card.question',
        'card.options',
        'card.recommend',
        'card.byDefault',
        'card.whyAsk',
        'card.gate',
        'card.run',
        'card.affects',
      ].map((field) => ({ id: 'T3', field, shape })),
    );
  });

  it('keeps the order it was given and has no cuts for clean tasks', () => {
    const body = bodyOf([testTask({ id: 'T9' }), testTask({ id: 'T2' }), testTask({ id: 'T5' })]);

    assert.deepEqual(
      body.tasks.map((task) => task.id),
      ['T9', 'T2', 'T5'],
    );
    assert.deepEqual(body.cuts, []);
  });

  it("serves one owner's tasks alone, and a task it leaves out adds no cut", () => {
    const body = bodyOf([testTask({ id: 'T1', owner: 'alpha' }), testTask({ id: 'T2', owner: 'bravo', title: SECRET }), testTask({ id: 'T3', owner: 'alpha' })], 'alpha');

    assert.deepEqual(
      body.tasks.map((task) => task.id),
      ['T1', 'T3'],
    );
    assert.deepEqual(body.cuts, []);
  });

  it('copies the lists, so a later change to the register does not reach a served answer', () => {
    const goals = ['g1'];
    const after = ['T5'];
    const task = only(bodyOf([testTask({ goals, after })]));
    goals.push('g2');
    after.push('T6');

    assert.deepEqual([task.goals, task.after], [['g1'], ['T5']]);
  });
});
