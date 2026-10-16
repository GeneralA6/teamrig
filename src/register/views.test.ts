import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import type { RegisterEvent } from './events.ts';
import {
  assignedNotice,
  byPlanOrder,
  cut,
  formatEvent,
  formatShortTask,
  formatTask,
  formatTaskDetail,
  formatVerifyByLine,
  formatVerifyRow,
  formatVerifySummary,
  selectTasks,
} from './views.ts';
import { waitContext, type WaitReason } from './waits.ts';

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
    testTask({ id: 'T2', owner: 'bravo', status: 'waiting', priority: 1, source: 'owner' }),
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
      formatTask(testTask({ status: 'waiting', note: 'waiting on disk' })),
      'T1 waiting, p2, owner alpha, from lead | Add a health check (waiting: waiting on disk)',
    );
    assert.equal(formatTask(testTask({ status: 'waiting' })), 'T1 waiting, p2, owner alpha, from lead | Add a health check');
    assert.equal(formatTask(testTask({ after: ['T5', 'T6'] })), 'T1 open, p2, owner alpha, after T5,T6, from lead | Add a health check');
    assert.equal(
      formatTask(testTask({ status: 'verifying', note: 'the nightly run is green', due: '2030-01-11' })),
      'T1 verifying, p2, owner alpha, due 01-11, from lead | Add a health check (proof: the nightly run is green)',
    );
    assert.equal(formatTask(testTask({ status: 'verifying' })), 'T1 verifying, p2, owner alpha, from lead | Add a health check');
    assert.equal(
      formatTask(testTask({ status: 'verifying', note: 'shipped', proof: 'the nightly run is green' })),
      'T1 verifying, p2, owner alpha, from lead | Add a health check (proof: the nightly run is green)',
    );
    assert.equal(formatTask(testTask({ status: 'in-progress', note: 'started' })), 'T1 in-progress, p2, owner alpha, from lead | Add a health check');
  });
});

describe('a task imported from GitHub', () => {
  it('names its issue in the short and the full row, and only for the github source', () => {
    const issue = testTask({ source: 'github', ref: 'gh:acme/web#7' });
    assert.equal(formatShortTask(issue, 80), 'T1 open, p2, owner alpha, from gh:acme/web#7 | Add a health check');
    assert.equal(formatTask(issue), 'T1 open, p2, owner alpha, from gh:acme/web#7 | Add a health check');
    assert.equal(formatShortTask(testTask({ ref: 'gh:acme/web#7' }), 80), 'T1 open, p2, owner alpha | Add a health check');
  });
});

describe('formatTask: what a waiting task waits for', () => {
  const waits: readonly WaitReason[] = [
    { kind: 'decision', who: 'owner' },
    { kind: 'approval', who: 'lead' },
    { kind: 'task', id: 'T304' },
    { kind: 'time', at: '2030-01-10 13:00' },
  ];
  const task = testTask({ status: 'waiting', note: 'the export', waits });

  it('names every reason in plain words, then the note', () => {
    assert.equal(
      formatTask(task),
      'T1 waiting, p2, owner alpha, from lead | Add a health check (waiting: decision owner · approval lead · on T304 · until Thu 01-10 13:00; the export)',
    );
  });

  it('marks each reason ready by the read it was printed from', () => {
    const tasks = new Map([['T304', testTask({ id: 'T304', status: 'done' })]]);
    assert.match(formatTask(task, undefined, waitContext(tasks, new Date('2030-01-10T13:00:00.000Z'))), /on T304 ready · until Thu 01-10 13:00 ready;/);
    assert.match(formatTask(task, undefined, waitContext(new Map([['T304', testTask({ status: 'open' })]]), new Date(0))), /on T304 · until Thu/);
    assert.match(formatShortTask(task, 60, 'web', waitContext(tasks, new Date(0))), /^web\/T1 waiting, p2, owner alpha \| Add a health check \(waiting: decision owner · approval lead · on T304 ready · until Thu 01-10 13:00\)$/);
  });
});

describe('formatShortTask and cut', () => {
  it('keeps the id, status, priority, owner and due date, and cuts the title', () => {
    const task = testTask({ id: 'T12', due: '2030-01-15', week: '2030-01-13', source: 'owner', goals: ['G1'], status: 'waiting', note: 'waiting on disk', after: ['T3'] });
    assert.equal(formatShortTask(task, 10), 'T12 waiting, p2, owner alpha, due 01-15, after T3 | Add a hea…');
    assert.equal(formatShortTask(testTask(), 60, 'web'), 'web/T1 open, p2, owner alpha | Add a health check');
  });

  it('cuts in code points, so a character outside the basic plane is never split', () => {
    assert.equal(cut('abc', 3), 'abc');
    assert.equal(cut('abcd', 3), 'ab…');
    assert.equal(cut('\u{1D400}\u{1D401}\u{1D402}\u{1D403}', 3), '\u{1D400}\u{1D401}…');
  });
});

describe('the verify queue lines', () => {
  const shipped = testTask({ status: 'verifying', proof: 'the nightly run', due: '2030-01-09', statusAt: '2030-01-07T10:30:00.000Z' });
  const long = testTask({ id: 'T2', status: 'verifying', proof: `the nightly run ${'and more '.repeat(10)}` });

  it('sums up a queue in one line, each proof cut short, and nothing for an empty one', () => {
    assert.equal(formatVerifySummary([]), undefined);
    const summary = formatVerifySummary([shipped, long]) ?? '';
    assert.match(summary, /^VERIFY 2: T1 \(proof: the nightly run\), T2 \(proof: the nightly run and more .*…\)$/);
    assert.ok(summary.length < 120);
  });

  it('prints a row with when it started verifying and the date to verify by', () => {
    assert.equal(formatVerifyRow(shipped), 'T1 since 01-07 10:30, verify by 01-09 | Add a health check (proof: the nightly run)');
    assert.equal(formatVerifyRow(testTask({ status: 'verifying' })), 'T1 since 01-07 09:00, no verify-by date | Add a health check (proof: no proof named)');
  });

  it("names the proof once the verify-by day has come", () => {
    assert.equal(formatVerifyByLine(shipped), 'VERIFY T1 was to be verified by 01-09 (proof: the nightly run): done with the proof, or back to in-progress');
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
      task: { title: 'x', description: 'Why x.', owner: 'alpha', source: 'owner', ref: 'inbox:3', priority: 1, due: '2030-01-08', goals: ['G1'], week: null, after: [] },
    },
    { v: 1, type: 'create', id: 'T2', at: AT, by: 'lead', task: { title: 'y', description: null, owner: 'bravo', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null, after: ['T1'] } },
    { v: 1, type: 'update', id: 'T1', at: '2030-01-07T10:00:00.000Z', by: 'lead', changes: { due: '2030-01-09', goals: ['G1', 'G2'] }, note: 'later' },
    { v: 1, type: 'status', id: 'T1', at: '2030-01-07T11:00:00.000Z', by: 'alpha', status: 'done', note: 'ok', evidence: 'abc1234', skill: 'none' },
    {
      v: 2,
      type: 'status',
      id: 'T2',
      at: '2030-01-07T12:00:00.000Z',
      by: 'bravo',
      status: 'waiting',
      note: 'n',
      evidence: null,
      skill: null,
      waits: [
        { kind: 'decision', who: 'owner' },
        { kind: 'time', at: '2030-01-09 12:00' },
      ],
    },
    { v: 2, type: 'update', id: 'T2', at: '2030-01-07T13:00:00.000Z', by: 'lead', changes: { after: ['T1', 'T3'] }, note: null },
  ];

  it('prints a note-only update as its note', () => {
    const event: RegisterEvent = { v: 1, type: 'update', id: 'T1', at: '2030-01-07T10:00:00.000Z', by: 'bravo', changes: {}, note: 'context' };
    assert.match(formatEvent(event), / bravo update note="context"$/);
  });

  it('prints each event type on one line', () => {
    assert.deepEqual(events.map(formatEvent), [
      '2030-01-07 09:00 lead create owner=alpha source=owner priority=p1 ref=inbox:3 due=2030-01-08 goals=G1',
      '2030-01-07 09:00 lead create owner=bravo source=lead priority=p2 after=T1',
      '2030-01-07 10:00 lead update due=2030-01-09 goals=G1,G2 note="later"',
      '2030-01-07 11:00 alpha status done note="ok" evidence=abc1234 skill=none',
      '2030-01-07 12:00 bravo status waiting waits="decision owner · until Wed 01-09 12:00" note="n"',
      '2030-01-07 13:00 lead update after=T1,T3',
    ]);
  });

  it('shows a task with its own history only', () => {
    const task = testTask({ status: 'done', ref: 'inbox:3', note: 'ok', evidence: 'abc1234', skill: 'none' });
    const detail = formatTaskDetail(task, events).split('\n');
    assert.deepEqual(detail.slice(1, 6), ['ref: inbox:3', 'note: ok', 'evidence: abc1234', 'skill: none', 'history:']);
    assert.equal(detail.length, 9);
    assert.ok(detail.slice(6).every((line) => !line.includes('owner=bravo')));
  });

  it('shows the proof of a verifying task and of its status line', () => {
    const proven: RegisterEvent = {
      v: 2,
      type: 'status',
      id: 'T3',
      at: '2030-01-07T14:00:00.000Z',
      by: 'alpha',
      status: 'verifying',
      note: 'shipped',
      evidence: null,
      skill: null,
      proof: 'the nightly run',
    };
    assert.equal(formatEvent(proven), '2030-01-07 14:00 alpha status verifying note="shipped" proof="the nightly run"');
    const detail = formatTaskDetail(testTask({ id: 'T3', status: 'verifying', note: 'shipped', proof: 'the nightly run' }), [proven]).split('\n');
    assert.deepEqual(detail.slice(1, 3), ['note: shipped', 'proof: the nightly run']);
  });

  it('shows the description under the task line, its later lines indented and a blank one kept blank', () => {
    const task = testTask({ ref: 'inbox:3', description: 'Users lose saved carts.\n\nKeep them:\n- a week' });
    const detail = formatTaskDetail(task, []).split('\n');
    assert.deepEqual(detail.slice(1, 7), ['description: Users lose saved carts.', '', '  Keep them:', '  - a week', 'ref: inbox:3', 'history:']);
    assert.ok(!formatTaskDetail(testTask(), []).includes('description'), 'a task with none prints no line');
  });

  it('prints a changed description on one quoted line, cut, and a cleared one as none', () => {
    const changed = (description: string | null): RegisterEvent => ({ v: 2, type: 'update', id: 'T1', at: AT, by: 'alpha', changes: { description }, note: null });
    assert.equal(formatEvent(changed('Why:\nusers ask')), '2030-01-07 09:00 alpha update description="Why: users ask"');
    assert.equal(formatEvent(changed(`${'d'.repeat(90)}`)), `2030-01-07 09:00 alpha update description="${'d'.repeat(79)}…"`);
    assert.equal(formatEvent(changed(null)), '2030-01-07 09:00 alpha update description=none');
  });
});

describe('assignedNotice', () => {
  it('names the task, its priority, its due date when it has one, and its title', () => {
    assert.equal(assignedNotice(testTask({ id: 'T5', due: '2030-01-10' })), 'T5 is yours (p2, due 2030-01-10): Add a health check');
    assert.equal(assignedNotice(testTask({ id: 'T5', priority: 1 })), 'T5 is yours (p1): Add a health check');
  });
});
