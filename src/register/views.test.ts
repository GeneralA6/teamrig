import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import type { RegisterEvent } from './events.ts';
import {
  assignedNotice,
  byPlanOrder,
  cut,
  formatEvent,
  formatNextMove,
  formatShortTask,
  formatTask,
  formatTaskDetail,
  formatTaskTree,
  formatVerifyByLine,
  formatVerifyRow,
  formatVerifySummary,
  formatWaitingOnYou,
  personWaitNotice,
  selectTasks,
  sizeText,
} from './views.ts';
import type { Task } from './fold.ts';
import { TaskTree } from './tree.ts';
import type { WaitReason } from './waits.ts';

const AT = '2030-01-07T09:00:00.000Z';
const NOW = new Date('2030-01-08T10:00:00.000Z');

function treeOf(...tasks: Task[]): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW);
}

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
  const ids = (filter: Parameters<typeof selectTasks>[1]) => selectTasks(tasks, filter, treeOf(...tasks)).map((task) => task.id);

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

  it('reads the effective due: a task inherits the earlier due of a task that needs it', () => {
    const held = [testTask({ id: 'T1' }), testTask({ id: 'T2', due: '2030-01-12' }), testTask({ id: 'T3', owner: 'bravo', due: '2030-01-09', after: ['T1'] })];
    const tree = treeOf(...held);
    assert.deepEqual(selectTasks(held, { dueBefore: new Date('2030-01-10T00:00:00Z') }, tree).map((task) => task.id), ['T1', 'T3']);
    assert.deepEqual(selectTasks(held, {}, tree).map((task) => task.id), ['T1', 'T3', 'T2'], 'T1 is due 01-09 by T3, and a tie goes to the lower id');
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
    assert.match(formatTask(task, undefined, new TaskTree(tasks, new Date('2030-01-10T13:00:00.000Z'))), /on T304 ready · until Thu 01-10 13:00 ready;/);
    assert.match(formatTask(task, undefined, new TaskTree(new Map([['T304', testTask({ status: 'open' })]]), new Date(0))), /on T304 · until Thu/);
    assert.match(formatShortTask(task, 60, 'web', new TaskTree(tasks, new Date(0))), /^web\/T1 waiting, p2, owner alpha \| Add a health check \(waiting: decision owner · approval lead · on T304 ready · until Thu 01-10 13:00\)$/);
  });
});

describe('a row read with the tree', () => {
  const holder = testTask({ id: 'T194', owner: 'beta', priority: 1, due: '2030-01-10', after: ['T2', 'T3', 'T7'] });
  const work = testTask({ id: 'T2', status: 'in-progress', due: '2030-01-15' });
  const early = testTask({ id: 'T3', due: '2030-01-09' });
  const later = testTask({ id: 'T5', owner: 'gamma', due: '2030-01-12', after: ['T2'] });
  const mine = testTask({ id: 'T6', after: ['T2', 'T3'] });
  const shipped = testTask({ id: 'T7', status: 'done' });
  const undated = testTask({ id: 'T8' });
  const asker = testTask({ id: 'T9', owner: 'beta', after: ['T8'] });
  const tree = treeOf(holder, work, early, later, mine, shipped, undated, asker);

  it('shows the inherited due, naming the task it comes from', () => {
    assert.equal(formatShortTask(work, 60, undefined, tree), 'T2 in-progress, p2, owner alpha, due 01-10 (from T194) | Add a health check · needed by T194 (beta) +1');
    assert.equal(formatTask(work, undefined, tree), 'T2 in-progress, p2, owner alpha, due 01-10 (from T194), from lead | Add a health check · needed by T194 (beta) +1');
  });

  it('names the first task of another session that needs it, with its due unless the row shows it', () => {
    assert.equal(formatShortTask(early, 60, undefined, tree), 'T3 open, p2, owner alpha, due 01-09 | Add a health check · needed by T194 (beta, due 01-10)');
    assert.equal(formatShortTask(undated, 60, undefined, tree), 'T8 open, p2, owner alpha | Add a health check · needed by T9 (beta)');
  });

  it('adds nothing for a finished task, or one only its own owner needs', () => {
    assert.equal(formatShortTask(shipped, 60, undefined, tree), 'T7 done, p2, owner alpha | Add a health check');
    assert.equal(formatShortTask(holder, 60, undefined, tree), 'T194 open, p1, owner beta, due 01-10, after T2,T3,T7 | Add a health check');
    const own = treeOf(work, mine);
    assert.equal(formatShortTask(work, 60, undefined, own), 'T2 in-progress, p2, owner alpha, due 01-15 | Add a health check');
  });
});

describe('formatTaskTree and formatNextMove', () => {
  it('prints what the task needs, what needs it, and the next move', () => {
    const root = testTask({ id: 'T1', after: ['T2', 'T9'] });
    const need = testTask({ id: 'T2', owner: 'beta', after: ['T3'] });
    const done = testTask({ id: 'T3', owner: 'beta', status: 'done' });
    const needer = testTask({ id: 'T4', owner: 'gamma', due: '2030-01-10', after: ['T1'] });
    const top = testTask({ id: 'T5', owner: 'lead', after: ['T4'] });
    assert.deepEqual(formatTaskTree(root, treeOf(root, need, done, needer, top), 60), [
      'needs:',
      '  T2 open, p2, owner beta, due 01-10 (from T4), after T3 | Add a health check',
      '    T3 done, p2, owner beta | Add a health check',
      '  T9 finished',
      'needed by:',
      '  T4 open, p2, owner gamma, due 01-10, after T1 | Add a health check',
      '    T5 open, p2, owner lead, after T4 | Add a health check',
      'Next move: beta (T2)',
    ]);
  });

  it('shows a task met again once, and marks a loop', () => {
    const root = testTask({ id: 'T1', after: ['T3', 'T2'] });
    const first = testTask({ id: 'T2', after: ['T3'] });
    const shared = testTask({ id: 'T3' });
    assert.deepEqual(formatTaskTree(root, treeOf(root, first, shared), 60).slice(0, 4), [
      'needs:',
      '  T2 open, p2, owner alpha, after T3 | Add a health check',
      '    T3 open, p2, owner alpha | Add a health check',
      '  T3 (shown above)',
    ]);
    const one = testTask({ id: 'T6', after: ['T7'] });
    const other = testTask({ id: 'T7', owner: 'beta', after: ['T6'] });
    assert.deepEqual(formatTaskTree(one, treeOf(one, other), 60), [
      'needs:',
      '  T7 open, p2, owner beta, after T6 | Add a health check',
      '    T6 (loop)',
      'needed by:',
      '  T7 open, p2, owner beta, after T6 | Add a health check',
      '    T6 (loop)',
      'Next move: none, what T6 needs runs in a loop (check flags it LOOP)',
    ]);
  });

  it('lists a finished task its needs, with no next move', () => {
    const done = testTask({ id: 'T3', status: 'done', after: ['T2'] });
    const need = testTask({ id: 'T2', status: 'done' });
    assert.deepEqual(formatTaskTree(done, treeOf(done, need), 60), [
      'needs:',
      '  T2 done, p2, owner alpha | Add a health check',
      'needed by: none',
      'Next move: none, T3 is done',
    ]);
    assert.deepEqual(formatTaskTree(need, treeOf(need), 60), ['needs: none', 'needed by: none', 'Next move: none, T2 is done']);
  });

  it('names a decision or approval, a time to pass, and a higher-priority task the mover works first', () => {
    const decided = testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }] });
    assert.equal(formatNextMove(decided, treeOf(decided)), 'Next move: owner (T1), decision');
    const parked = testTask({ id: 'T1', status: 'waiting', waits: [{ kind: 'time', at: '2030-01-10 13:00' }] });
    assert.equal(formatNextMove(parked, treeOf(parked)), 'Next move: alpha (T1), from Thu 01-10 13:00');
    const open = testTask({ id: 'T1' });
    const urgent = testTask({ id: 'T7', status: 'in-progress', priority: 1 });
    assert.equal(formatNextMove(open, treeOf(open, urgent)), 'Next move: alpha (T1), behind T7 (p1)');
  });
});

describe('formatWaitingOnYou', () => {
  it('names the tasks of yours it needs and the decisions it waits on', () => {
    const yours = testTask({ id: 'T2', status: 'in-progress' });
    const theirs = testTask({ id: 'T4', owner: 'beta', status: 'waiting', waits: [{ kind: 'task', id: 'T2' }, { kind: 'approval', who: 'alpha' }] });
    const tree = treeOf(yours, theirs);
    const [entry] = tree.waitingOn('alpha');
    assert.ok(entry !== undefined);
    assert.equal(formatWaitingOnYou(entry, 60, tree), 'T4 waiting, p2, owner beta | Add a health check (waiting: on T2 · approval alpha) · needs your T2 · waits on your approval');
    const asked = testTask({ id: 'T5', owner: 'beta', status: 'waiting', waits: [{ kind: 'decision', who: 'alpha' }] });
    const [only] = treeOf(asked).waitingOn('alpha');
    assert.ok(only !== undefined);
    assert.equal(formatWaitingOnYou(only, 60, treeOf(asked)), 'T5 waiting, p2, owner beta | Add a health check (waiting: decision alpha) · waits on your decision');
    const needOnly = testTask({ id: 'T6', owner: 'beta', after: ['T2'] });
    const [planned] = treeOf(yours, needOnly).waitingOn('alpha');
    assert.ok(planned !== undefined);
    assert.equal(formatWaitingOnYou(planned, 60, treeOf(yours, needOnly)), 'T6 open, p2, owner beta, after T2 | Add a health check · needs your T2');
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
      task: { title: 'x', description: 'Why x.', owner: 'alpha', source: 'owner', ref: 'inbox:3', priority: 1, due: '2030-01-08', goals: ['G1'], week: null, after: [], size: null },
    },
    { v: 1, type: 'create', id: 'T2', at: AT, by: 'lead', task: { title: 'y', description: null, owner: 'bravo', source: 'lead', ref: null, priority: 2, due: null, goals: [], week: null, after: ['T1'], size: null } },
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

  it('shows the follow-ups a status line named, none as none, and those of a task', () => {
    const closed: RegisterEvent = {
      v: 2,
      type: 'status',
      id: 'T3',
      at: '2030-01-07T14:00:00.000Z',
      by: 'alpha',
      status: 'done',
      note: 'ok',
      evidence: 'abc1234',
      skill: 'none',
      followups: ['T4', 'T5'],
    };
    assert.equal(formatEvent(closed), '2030-01-07 14:00 alpha status done note="ok" evidence=abc1234 skill=none followups=T4,T5');
    assert.match(formatEvent({ ...closed, followups: [] }), / skill=none followups=none$/);
    const task = testTask({ id: 'T3', status: 'done', note: 'ok', evidence: 'abc1234', skill: 'none', followups: ['T4', 'T5'] });
    assert.deepEqual(formatTaskDetail(task, [closed]).split('\n').slice(1, 6), ['note: ok', 'evidence: abc1234', 'skill: none', 'followups: T4, T5', 'history:']);
    assert.ok(!formatTaskDetail(testTask(), []).includes('followups'), 'a task with none prints no line');
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

  it('prints a size as a percent of the weekly limit, on create, update and the detail', () => {
    const sized = testTask({ id: 'T1', size: 1.255 });
    const created: RegisterEvent = { v: 2, type: 'create', id: 'T1', at: AT, by: 'alpha', task: { ...sized, size: 1.5 } };
    assert.match(formatEvent(created), / size=1\.5%$/);
    const resized = (size: number | null): RegisterEvent => ({ v: 2, type: 'update', id: 'T1', at: AT, by: 'lead', changes: { size }, note: null });
    assert.equal(formatEvent(resized(0.5)), '2030-01-07 09:00 lead update size=0.5%');
    assert.equal(formatEvent(resized(null)), '2030-01-07 09:00 lead update size=none');
    assert.ok(formatTaskDetail(sized, []).split('\n').includes('size: 1.25% of the weekly limit'));
    assert.ok(!formatTaskDetail(testTask(), []).includes('size'), 'a task with none prints no line');
    assert.deepEqual([sizeText(2), sizeText(0.125), sizeText(33.333)], ['2%', '0.13%', '33.33%']);
  });
});

describe('personWaitNotice', () => {
  const task = testTask({ id: 'T2', note: 'pick the  backup\nwindow', title: 'Move the backups' });

  it("tells the lead what the task waits on, the lead's waits as its own, the owner's by name, with the note on one line", () => {
    assert.equal(personWaitNotice(task, [{ kind: 'approval', who: 'lead' }], 'lead'), 'T2 waits on your approval: pick the backup window');
    assert.equal(personWaitNotice(task, [{ kind: 'decision', who: 'owner' }], 'lead'), "T2 waits on the owner's decision: pick the backup window");
    assert.equal(
      personWaitNotice(task, [{ kind: 'decision', who: 'owner' }, { kind: 'approval', who: 'lead' }, { kind: 'approval', who: 'owner' }], 'lead'),
      "T2 waits on your approval and the owner's decision and approval: pick the backup window",
    );
  });

  it('names the title when the task has no note', () => {
    assert.equal(personWaitNotice({ ...task, note: null }, [{ kind: 'decision', who: 'lead' }], 'lead'), 'T2 waits on your decision: Move the backups');
  });
});

describe('assignedNotice', () => {
  it('names the task, its priority, its due date when it has one, and its title', () => {
    assert.equal(assignedNotice(testTask({ id: 'T5', due: '2030-01-10' })), 'T5 is yours (p2, due 2030-01-10): Add a health check');
    assert.equal(assignedNotice(testTask({ id: 'T5', priority: 1 })), 'T5 is yours (p1): Add a health check');
  });
});
