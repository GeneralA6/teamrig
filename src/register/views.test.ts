import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import type { RegisterEvent } from './events.ts';
import { byPlanOrder, cut, formatEvent, formatShortTask, formatTask, formatTaskDetail, selectTasks } from './views.ts';

const AT = '2030-01-07T09:00:00.000Z';

describe('byPlanOrder', () => {
  it('sorts by priority, then due date with undated last, then id number', () => {
    const tasks = [
      testTask({ id: 'T10', priority: 2 }),
      testTask({ id: 'T3', priority: 2, due: '2030-01-09' }),
      testTask({ id: 'T2', priority: 2 }),
      testTask({ id: 'T4', priority: 2, due: '2030-01-08 12:00' }),
      testTask({ id: 'T9', priority: 1 }),
    ];
    assert.deepEqual(tasks.sort(byPlanOrder).map((task) => task.id), ['T9', 'T4', 'T3', 'T2', 'T10']);
  });
});

describe('selectTasks', () => {
  const tasks = [
    testTask({ id: 'T1', owner: 'alpha', due: '2030-01-08', week: '2030-01-07', goals: ['G1'] }),
    testTask({ id: 'T2', owner: 'bravo', status: 'blocked', priority: 1, source: 'owner' }),
    testTask({ id: 'T3', owner: 'alpha', status: 'done' }),
  ];
  const ids = (filter: Parameters<typeof selectTasks>[1]) => selectTasks(tasks, filter).map((task) => task.id);

  it('shows active tasks by default and filters on every field', () => {
    assert.deepEqual(ids({}), ['T2', 'T1']);
    assert.deepEqual(ids({ statuses: ['done'] }), ['T3']);
    assert.deepEqual(ids({ owner: 'alpha' }), ['T1']);
    assert.deepEqual(ids({ source: 'owner' }), ['T2']);
    assert.deepEqual(ids({ priorities: [2] }), ['T1']);
    assert.deepEqual(ids({ dueBefore: new Date('2030-01-09T00:00:00Z') }), ['T1']);
    assert.deepEqual(ids({ dueBefore: new Date('2030-01-08T12:00:00Z') }), [], 'a bare day is due at its end');
    assert.deepEqual(ids({ week: '2030-01-07' }), ['T1']);
    assert.deepEqual(ids({ week: null }), ['T2']);
    assert.deepEqual(ids({ goal: 'G1' }), ['T1']);
  });
});

describe('formatTask', () => {
  it('prints one compact line', () => {
    const task = testTask({ id: 'T12', due: '2030-01-15', week: '2030-01-13', source: 'owner', goals: ['G1', 'G2'] });
    assert.equal(formatTask(task), 'T12 open, p2, owner alpha, due 01-15, week 01-13, from owner, goals G1,G2 | Add a health check');
    assert.equal(
      formatTask(testTask({ status: 'blocked', note: 'waiting on disk' })),
      'T1 blocked, p2, owner alpha, from lead | Add a health check (blocked: waiting on disk)',
    );
    assert.equal(
      formatTask(testTask({ status: 'verifying', note: 'the nightly run is green', due: '2030-01-11' })),
      'T1 verifying, p2, owner alpha, due 01-11, from lead | Add a health check (proof: the nightly run is green)',
    );
    assert.equal(formatTask(testTask({ status: 'verifying' })), 'T1 verifying, p2, owner alpha, from lead | Add a health check');
    assert.equal(formatTask(testTask({ status: 'in-progress', note: 'started' })), 'T1 in-progress, p2, owner alpha, from lead | Add a health check');
  });
});

describe('formatShortTask and cut', () => {
  it('keeps the id, status, priority, owner and due date, and cuts the title', () => {
    const task = testTask({ id: 'T12', due: '2030-01-15', week: '2030-01-13', source: 'owner', goals: ['G1'], status: 'blocked', note: 'waiting on disk' });
    assert.equal(formatShortTask(task, 10), 'T12 blocked, p2, owner alpha, due 01-15 | Add a hea…');
    assert.equal(formatShortTask(testTask(), 60, 'web'), 'web/T1 open, p2, owner alpha | Add a health check');
  });

  it('cuts in code points, so a character outside the basic plane is never split', () => {
    assert.equal(cut('abc', 3), 'abc');
    assert.equal(cut('abcd', 3), 'ab…');
    assert.equal(cut('\u{1D400}\u{1D401}\u{1D402}\u{1D403}', 3), '\u{1D400}\u{1D401}…');
  });
});

describe('formatEvent and formatTaskDetail', () => {
  const events: RegisterEvent[] = [
    {
      v: 1,
      type: 'create',
      id: 'T1',
      at: AT,
      by: 'lead',
      task: { title: 'x', owner: 'alpha', source: 'owner', ref: 'inbox:3', priority: 1, due: '2030-01-08', goals: ['G1'], week: null },
    },
    { v: 1, type: 'create', id: 'T2', at: AT, by: 'lead', task: { title: 'y', owner: 'bravo', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null } },
    { v: 1, type: 'update', id: 'T1', at: '2030-01-07T10:00:00.000Z', by: 'lead', changes: { due: '2030-01-09', goals: ['G1', 'G2'] }, note: 'later' },
    { v: 1, type: 'status', id: 'T1', at: '2030-01-07T11:00:00.000Z', by: 'alpha', status: 'done', note: 'ok', evidence: 'abc1234', skill: 'none' },
  ];

  it('prints each event type on one line', () => {
    assert.deepEqual(events.map(formatEvent), [
      '2030-01-07 09:00 lead create owner=alpha source=owner priority=p1 ref=inbox:3 due=2030-01-08 goals=G1',
      '2030-01-07 09:00 lead create owner=bravo source=lead priority=p2',
      '2030-01-07 10:00 lead update due=2030-01-09 goals=G1,G2 note="later"',
      '2030-01-07 11:00 alpha status done note="ok" evidence=abc1234 skill=none',
    ]);
  });

  it('shows a task with its own history only', () => {
    const task = testTask({ status: 'done', ref: 'inbox:3', note: 'ok', evidence: 'abc1234', skill: 'none' });
    const detail = formatTaskDetail(task, events).split('\n');
    assert.deepEqual(detail.slice(1, 6), ['ref: inbox:3', 'note: ok', 'evidence: abc1234', 'skill: none', 'history:']);
    assert.equal(detail.length, 9);
    assert.ok(detail.slice(6).every((line) => !line.includes('owner=bravo')));
  });
});
