import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_CARD } from '../testing/card.ts';
import { testTask } from '../testing/task.ts';
import type { ItemType, RegisterEvent, TaskFields } from './events.ts';
import {
  aheadReason,
  aheadText,
  approvalNotice,
  askedNotice,
  assignedNotice,
  byPlanOrder,
  dueTime,
  cut,
  endedNotice,
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
  formatWatchRow,
  personWaitNotice,
  selectTasks,
  sizeText,
  SUMMARY_VERIFY_ROWS,
  verifySummaryPointer,
  type DetailExtras,
} from './views.ts';
import type { Task } from './fold.ts';
import { NO_TASKS_ELSEWHERE, TaskTree } from './tree.ts';
import { TEST_OWNER_SOURCE, testRanking, type TestRankingFacts } from '../testing/ranking.ts';
import type { WatchedTask } from './verify.ts';
import type { WaitReason } from './waits.ts';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';

const AT = '2030-01-07T09:00:00.000Z';
const NOW = new Date('2030-01-08T10:00:00.000Z');

/** A read with no task in it, at NOW: each task keeps its own due. */
const TREE = treeOf();

/** What `show` adds when no card hands a hand step file. */
const EXTRAS: DetailExtras = { runFiles: new Map() };

function treeOf(...tasks: Task[]): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC);
}

/** A read at NOW that ranks its tasks by `facts`. */
function rankedTree(facts: TestRankingFacts, ...tasks: Task[]): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC, null, NO_TASKS_ELSEWHERE, testRanking(facts));
}

describe('byPlanOrder', () => {
  it('sorts by due date with undated last, then id number, whatever the priority', () => {
    const tasks = [
      testTask({ id: 'T10', priority: 2 }),
      testTask({ id: 'T3', priority: 2, due: '2030-01-09' }),
      testTask({ id: 'T2', priority: 2 }),
      testTask({ id: 'T4', priority: 2, due: '2030-01-08 12:00' }),
      testTask({ id: 'T9', priority: 1 }),
    ];
    assert.deepEqual(tasks.sort((a, b) => byPlanOrder(a, b, TimeZone.UTC)).map((task) => task.id), ['T4', 'T3', 'T2', 'T9', 'T10']);
  });
});

describe('selectTasks', () => {
  const tasks = [
    testTask({ id: 'T1', owner: 'alpha', due: '2030-01-08', week: '2030-01-07', goals: ['G1'] }),
    testTask({ id: 'T2', owner: 'bravo', status: 'waiting', priority: 1, source: 'owner', type: 'bug' }),
    testTask({ id: 'T3', owner: 'alpha', status: 'done' }),
  ];
  const ids = (filter: Parameters<typeof selectTasks>[1]) => selectTasks(tasks, filter, treeOf(...tasks)).map((task) => task.id);

  it('shows active tasks by default and filters on every field', () => {
    assert.deepEqual(ids({}), ['T1', 'T2']);
    assert.deepEqual(ids({ statuses: ['done'] }), ['T3']);
    assert.deepEqual(ids({ owner: 'alpha' }), ['T1']);
    assert.deepEqual(ids({ source: 'owner' }), ['T2']);
    assert.deepEqual(ids({ priorities: [2] }), ['T1']);
    assert.deepEqual(ids({ dueBefore: new Date('2030-01-09T00:00:00Z') }), ['T1']);
    assert.deepEqual(ids({ dueBefore: new Date('2030-01-08T12:00:00Z') }), [], 'a bare day is due at its end');
    assert.deepEqual(ids({ week: '2030-01-07' }), ['T1']);
    assert.deepEqual(ids({ week: null }), ['T2']);
    assert.deepEqual(ids({ goal: 'G1' }), ['T1']);
    assert.deepEqual(ids({ types: ['bug'] }), ['T2']);
    assert.deepEqual(ids({ types: ['task'] }), ['T1'], 'a task with no type counts as a task');
    assert.deepEqual(ids({ types: ['task', 'bug'] }), ['T1', 'T2']);
  });

  it('reads the effective due: a task inherits the earlier due of a task that needs it', () => {
    const held = [testTask({ id: 'T1' }), testTask({ id: 'T2', due: '2030-01-12' }), testTask({ id: 'T3', owner: 'bravo', due: '2030-01-09', after: ['T1'] })];
    const tree = treeOf(...held);
    assert.deepEqual(selectTasks(held, { dueBefore: new Date('2030-01-10T00:00:00Z') }, tree).map((task) => task.id), ['T1', 'T3']);
    assert.deepEqual(selectTasks(held, {}, tree).map((task) => task.id), ['T1', 'T2', 'T3'], 'T1 is due 01-09 by T3, which cannot move until it is done');
  });

  it('leaves a parked task out, shows only those with parked, and takes one back after an event', () => {
    const quiet = testTask({ id: 'T1', workClass: 'Improvements', updatedAt: '2029-12-01T09:00:00.000Z' });
    const live = testTask({ id: 'T2', workClass: 'Improvements', updatedAt: AT });
    const shown = (held: readonly Task[], filter: Parameters<typeof selectTasks>[1]) => selectTasks(held, filter, rankedTree({}, ...held)).map((task) => task.id);
    assert.deepEqual(shown([quiet, live], {}), ['T2']);
    assert.deepEqual(shown([quiet, live], { parked: true }), ['T1']);
    assert.deepEqual(shown([{ ...quiet, updatedAt: AT }, live], {}), ['T1', 'T2'], 'any event moves updatedAt');
  });
});

describe('formatTask', () => {
  it('prints one compact line', () => {
    const task = testTask({ id: 'T12', due: '2030-01-15', week: '2030-01-13', source: 'owner', goals: ['G1', 'G2'] });
    assert.equal(formatTask(task, undefined, TREE), 'T12 open, p2, owner alpha, due 01-15, week 01-13, from owner, goals G1,G2 | Add a health check');
    assert.equal(
      formatTask(testTask({ status: 'waiting', note: 'waiting on disk' }), undefined, TREE),
      'T1 waiting, p2, owner alpha, from lead | Add a health check (waiting: waiting on disk)',
    );
    assert.equal(formatTask(testTask({ status: 'waiting' }), undefined, TREE), 'T1 waiting, p2, owner alpha, from lead | Add a health check');
    assert.equal(formatTask(testTask({ after: ['T5', 'T6'] }), undefined, TREE), 'T1 open, p2, owner alpha, after T5,T6, from lead | Add a health check');
    assert.equal(
      formatTask(testTask({ status: 'verifying', note: 'the nightly run is green', due: '2030-01-11' }), undefined, TREE),
      'T1 verifying, p2, owner alpha, due 01-11, from lead | Add a health check (proof: the nightly run is green)',
    );
    assert.equal(formatTask(testTask({ status: 'verifying' }), undefined, TREE), 'T1 verifying, p2, owner alpha, from lead | Add a health check');
    assert.equal(
      formatTask(testTask({ status: 'verifying', note: 'shipped', proof: 'the nightly run is green' }), undefined, TREE),
      'T1 verifying, p2, owner alpha, from lead | Add a health check (proof: the nightly run is green)',
    );
    const proofWaits = testTask({ status: 'verifying', proof: 'the nightly run is green', waits: [{ kind: 'task', id: 'T9' }] });
    assert.equal(
      formatTask(proofWaits, undefined, treeOf(testTask({ id: 'T9' }))),
      'T1 verifying, p2, owner alpha, from lead | Add a health check (proof: the nightly run is green; waiting: on T9)',
    );
    assert.equal(
      formatTask(proofWaits, undefined, treeOf(testTask({ id: 'T9', status: 'done' }))),
      'T1 verifying, p2, owner alpha, from lead | Add a health check (proof: the nightly run is green; waiting: on T9 ready)',
    );
    assert.equal(formatTask(testTask({ status: 'in-progress', note: 'started' }), undefined, TREE), 'T1 in-progress, p2, owner alpha, from lead | Add a health check');
    assert.equal(
      formatTask(testTask({ status: 'done', note: 'tests green', watch: 'the row shows' }), undefined, TREE),
      'T1 done, p2, owner alpha, from lead | Add a health check (watch: the row shows)',
    );
  });
});

describe('a task imported from GitHub', () => {
  it('names its issue in the short and the full row, and only for the github source', () => {
    const issue = testTask({ source: 'github', ref: 'gh:acme/web#7' });
    assert.equal(formatShortTask(issue, 80, undefined, TREE), 'T1 open, p2, owner alpha, from gh:acme/web#7 | Add a health check');
    assert.equal(formatTask(issue, undefined, TREE), 'T1 open, p2, owner alpha, from gh:acme/web#7 | Add a health check');
    assert.equal(formatShortTask(testTask({ ref: 'gh:acme/web#7' }), 80, undefined, TREE), 'T1 open, p2, owner alpha, issue #7 | Add a health check', 'a posted task is marked by its issue');
  });
});

describe('the placement mark (T2608)', () => {
  it('marks a task kept local, one the team posted by its issue number, and none that is neither', () => {
    assert.equal(formatShortTask(testTask({ local: 'security' }), 80, undefined, TREE), 'T1 open, p2, owner alpha, local | Add a health check');
    assert.equal(formatTask(testTask({ ref: 'gh:acme/web#933' }), undefined, TREE), 'T1 open, p2, owner alpha, issue #933, from lead | Add a health check');
    assert.equal(formatShortTask(testTask({ ref: 'inbox:3' }), 80, undefined, TREE), 'T1 open, p2, owner alpha | Add a health check', 'a ref that is no issue');
    assert.equal(formatShortTask(testTask({ ref: 'gh:acme/web' }), 80, undefined, TREE), 'T1 open, p2, owner alpha | Add a health check', 'an issue ref with no number');
  });

  it('prints the reason in show, and a local reason set or cleared in the history', () => {
    const detail = formatTaskDetail(testTask({ local: 'team operations' }), [], TREE, EXTRAS).split('\n');
    assert.ok(detail.includes('local: team operations (kept off the issue tracker)'), detail.join('\n'));
    const fields = { title: 'x', description: null, owner: 'alpha', source: 'lead', ref: null, priority: 2, due: null, goals: [], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null, workClass: null, local: 'security' };
    assert.match(formatEvent({ v: 2, type: 'create', id: 'T1', at: AT, by: 'lead', task: fields }, TimeZone.UTC), / local="security"$/);
    assert.match(formatEvent({ v: 2, type: 'update', id: 'T1', at: AT, by: 'lead', changes: { local: 'a private repo' }, note: null }, TimeZone.UTC), / local="a private repo"$/);
    assert.match(formatEvent({ v: 2, type: 'update', id: 'T1', at: AT, by: 'lead', changes: { local: null }, note: null }, TimeZone.UTC), / local=none$/);
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
      formatTask(task, undefined, treeOf(testTask({ id: 'T304' }))),
      'T1 waiting, p2, owner alpha, from lead | Add a health check (waiting: decision owner · approval lead · on T304 · until Thu 01-10 13:00 UTC; the export)',
    );
  });

  it('marks each reason ready by the read it was printed from', () => {
    const tasks = new Map([['T304', testTask({ id: 'T304', status: 'done' })]]);
    assert.match(formatTask(task, undefined, new TaskTree(tasks, new Date('2030-01-10T13:00:00.000Z'), TimeZone.UTC)), /on T304 ready · until Thu 01-10 13:00 UTC ready;/);
    assert.match(formatTask(task, undefined, new TaskTree(new Map([['T304', testTask({ status: 'open' })]]), new Date(0), TimeZone.UTC)), /on T304 · until Thu/);
    assert.match(formatShortTask(task, 60, 'web', new TaskTree(tasks, new Date(0), TimeZone.UTC)), /^web\/T1 waiting, p2, owner alpha \| Add a health check \(waiting: decision owner · approval lead · on T304 ready · until Thu 01-10 13:00 UTC\)$/);
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
      '  T3 open, p2, owner alpha | Add a health check',
      '  T2 open, p2, owner alpha, after T3 | Add a health check',
      '    T3 (shown above)',
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

  it("reads a need another register of the team tree holds as its row there, and names its owner's move", () => {
    const root = testTask({ id: 'T1', after: ['T20', 'T21', 'T9'] });
    const elsewhere = new Map([
      ['T20', { team: 'web', task: testTask({ id: 'T20', owner: 'lead', status: 'in-progress', after: ['T22'] }) }],
      ['T21', { team: 'web', task: testTask({ id: 'T21', status: 'done' }) }],
    ]);
    assert.deepEqual(formatTaskTree(root, new TaskTree(new Map([[root.id, root]]), NOW, TimeZone.UTC, undefined, elsewhere), 60), [
      'needs:',
      '  web/T20 in-progress, p2, owner lead, after T22 | Add a health check',
      '  web/T21 done, p2, owner alpha | Add a health check',
      '  T9 finished',
      'needed by: none',
      'Next move: lead on team web (web/T20)',
    ]);
  });

  it("names another team's register, read as that team reads it, in its rows and its next move", () => {
    const root = testTask({ id: 'T1', after: ['T2'] });
    const need = testTask({ id: 'T2', owner: 'bravo' });
    assert.deepEqual(formatTaskTree(root, treeOf(root, need), 60, 'web'), [
      'needs:',
      '  web/T2 open, p2, owner bravo | Add a health check',
      'needed by: none',
      'Next move: bravo on team web (web/T2)',
    ]);
    const done = testTask({ id: 'T3', status: 'done' });
    assert.deepEqual(formatTaskTree(done, treeOf(done), 60, 'web').at(-1), 'Next move: none, web/T3 is done');
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
    assert.equal(formatNextMove(parked, treeOf(parked)), 'Next move: alpha (T1), from Thu 01-10 13:00 UTC');
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

describe('a row of a ranked tree', () => {
  it('shows the class and score right after the status', () => {
    const task = testTask({ id: 'T12', title: 'Add a health check', size: 3 });
    const tree = rankedTree({ classes: { T12: 'Roadmap' }, goals: { T12: { tag: 'A1', rank: 1 } } }, task);
    assert.equal(formatShortTask(task, 60, undefined, tree), 'T12 open, Roadmap, score 6.67, p2, owner alpha | Add a health check');
  });

  it('shows neither in a tree that does not rank', () => {
    const task = testTask({ id: 'T12', title: 'Add a health check' });
    assert.equal(formatShortTask(task, 60, undefined, treeOf(task)), 'T12 open, p2, owner alpha | Add a health check');
  });
});

describe('aheadReason and aheadText: why a row sorts ahead of the next', () => {
  const placed = (task: Task, tree: TaskTree = TREE) => ({ task, tree });
  const later = testTask({ id: 'T9' });

  it('names the deciding key the row does not show', () => {
    assert.equal(aheadReason(placed(testTask({ id: 'T12', status: 'in-progress' })), placed(later)), 'in progress');
    assert.equal(aheadReason(placed(testTask({ id: 'T12', due: '2030-01-09' })), placed(later)), 'due');
    assert.equal(aheadReason(placed(testTask({ id: 'T12', size: 0.5 })), placed(later)), 'size 0.5%');
    const week = new TaskTree(new Map(), NOW, TimeZone.UTC, '2030-01-07');
    assert.equal(aheadReason(placed(testTask({ id: 'T12', week: '2030-01-07' }), week), placed(later, week)), 'in week 01-07');
  });

  it('names the best task that needs it, its priority and how many more', () => {
    const work = testTask({ id: 'T3' });
    const needers = [testTask({ id: 'T8', after: ['T3'] }), testTask({ id: 'T7', priority: 1, after: ['T3'] }), testTask({ id: 'T9', priority: 1, after: ['T3'] })];
    const many = treeOf(work, later, ...needers);
    assert.equal(aheadReason(placed(work, many), placed(later, many)), 'unblocks T7 p1 +2');
    const one = treeOf(work, later, testTask({ id: 'T8', after: ['T3'] }));
    assert.equal(aheadReason(placed(work, one), placed(later, one)), 'unblocks T8 p2');
  });

  it('names an expedite, and leaves any other band to the class the row shows', () => {
    const expedite = testTask({ id: 'T12', source: TEST_OWNER_SOURCE, priority: 1 });
    const roadmap = testTask({ id: 'T13' });
    const rest = testTask({ id: 'T14' });
    const tree = rankedTree({ classes: { T13: 'Roadmap' } }, expedite, roadmap, rest);
    assert.equal(aheadReason(placed(expedite, tree), placed(roadmap, tree)), 'expedite');
    assert.equal(aheadReason(placed(roadmap, tree), placed(rest, tree)), undefined);
  });

  it('says a row can move when the next row, for all its score, cannot', () => {
    const work = testTask({ id: 'T12', size: 5 });
    const blocked = testTask({ id: 'T13', size: 0.1, after: ['T12'] });
    const tree = rankedTree({}, work, blocked);
    assert.equal(aheadReason(placed(work, tree), placed(blocked, tree)), 'can move');
    assert.equal(aheadText(placed(work, tree), placed(blocked, tree)), ' · ahead: can move');
    assert.equal(aheadReason(placed(blocked, tree), placed(work, tree)), undefined, 'the next row sorts ahead');
  });

  it('names the score, with the ranked goal it serves when it serves one', () => {
    const first = testTask({ id: 'T12', size: 1 });
    const second = testTask({ id: 'T13', size: 3 });
    const third = testTask({ id: 'T14', size: 4 });
    const tree = rankedTree({ classes: { T12: 'Roadmap', T13: 'Roadmap', T14: 'Roadmap' }, goals: { T12: { tag: 'A1', rank: 1 } } }, first, second, third);
    assert.equal(aheadReason(placed(first, tree), placed(second, tree)), 'score 20 (A1 #1)');
    assert.equal(aheadReason(placed(second, tree), placed(third, tree)), 'score 1');
  });

  it('names nothing when the row shows it, the number decides, they tie or the next row sorts ahead', () => {
    assert.equal(aheadReason(placed(testTask({ id: 'T12', pin: 'lead', priority: 3 })), placed(later)), undefined, 'the row says pinned');
    assert.equal(aheadReason(placed(testTask({ id: 'T2' })), placed(later)), undefined);
    assert.equal(aheadReason(placed(later), placed(later)), undefined);
    assert.equal(aheadReason(placed(later), placed(testTask({ id: 'T12', status: 'in-progress' }))), undefined);
  });

  it('places each row by its own register', () => {
    const work = testTask({ id: 'T12' });
    const dated = treeOf(work, testTask({ id: 'T13', due: '2030-01-09', after: ['T12'] }));
    assert.equal(aheadReason(placed(work, dated), placed(later)), 'due');
    assert.equal(aheadReason(placed(work), placed(later)), undefined);
  });

  it('reads as the tail of a row, empty for the last row or without a reason', () => {
    assert.equal(aheadText(placed(testTask({ id: 'T12', status: 'in-progress' })), placed(later)), ' · ahead: in progress');
    assert.equal(aheadText(placed(later), undefined), '');
    assert.equal(aheadText(placed(testTask({ id: 'T2' })), placed(later)), '');
  });
});

describe('formatShortTask and cut', () => {
  it('keeps the id, status, priority, owner and due date, and cuts the title', () => {
    const task = testTask({ id: 'T12', due: '2030-01-15', week: '2030-01-13', source: 'owner', goals: ['G1'], status: 'waiting', note: 'waiting on disk', after: ['T3'] });
    assert.equal(formatShortTask(task, 10, undefined, TREE), 'T12 waiting, p2, owner alpha, due 01-15, after T3 | Add a hea…');
    assert.equal(formatShortTask(testTask(), 60, 'web', TREE), 'web/T1 open, p2, owner alpha | Add a health check');
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

  it('sums up a queue as a heading and a row per task, each proof cut short, and nothing for an empty one', () => {
    assert.equal(formatVerifySummary([], [], 'alpha', 'kit'), undefined);
    const lines = (formatVerifySummary([shipped, long], [], 'alpha', 'kit') ?? '').split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'VERIFY 2, oldest first:');
    assert.equal(lines[1], '  T1 (proof: the nightly run)');
    assert.match(lines[2] ?? '', /^ {2}T2 \(proof: the nightly run and more .*…\)$/);
    assert.ok(lines.every((line) => line.length < 80), lines.join('\n'));
  });

  it(`names the first ${SUMMARY_VERIFY_ROWS} tasks of a longer queue and the command that lists the rest`, () => {
    const queue = Array.from({ length: SUMMARY_VERIFY_ROWS + 2 }, (_, index) => testTask({ id: `T${index + 1}`, status: 'verifying', proof: 'the nightly run' }));
    const lines = (formatVerifySummary(queue, [], 'alpha', 'kit') ?? '').split('\n');
    assert.equal(lines[0], `VERIFY ${SUMMARY_VERIFY_ROWS + 2}, oldest first:`);
    assert.deepEqual(lines.slice(1, -1), queue.slice(0, SUMMARY_VERIFY_ROWS).map((task) => `  ${task.id} (proof: the nightly run)`));
    assert.equal(lines.at(-1), '  +2 more: `kit verify --session alpha`');
  });

  it('ends with a line counting the done tasks watched for a sighting, alone when nothing verifies (T1306)', () => {
    const watched = [testTask({ id: 'T3', status: 'done', watch: 'the row shows' }), testTask({ id: 'T4', status: 'done', watch: 'the page loads' })];
    assert.equal(formatVerifySummary([], watched, 'alpha', 'kit'), 'WATCH 2 done, waiting on a sighting: `kit verify --session alpha`');
    assert.deepEqual((formatVerifySummary([shipped], watched, 'alpha', 'kit') ?? '').split('\n'), [
      'VERIFY 1, oldest first:',
      '  T1 (proof: the nightly run)',
      'WATCH 2 done, waiting on a sighting: `kit verify --session alpha`',
    ]);
  });

  it('points a start with no room for the rows to the command that lists them (T1376)', () => {
    assert.equal(verifySummaryPointer('alpha', 'kit'), 'VERIFY: this start has no room for your verifying and watched tasks; `kit verify --session alpha` lists them.');
  });

  it('prints a watched row with when it was closed and the sighting to watch for (T1306)', () => {
    const watched: WatchedTask = { ...testTask({ status: 'done', statusAt: '2030-01-07T10:30:00.000Z' }), watch: 'the row shows' };
    assert.equal(formatWatchRow(watched, TimeZone.UTC), 'T1 done 01-07 10:30 UTC | Add a health check (watch: the row shows)');
  });

  it('prints a row with when it started verifying and the date to verify by', () => {
    assert.equal(formatVerifyRow(shipped, TimeZone.UTC), 'T1 since 01-07 10:30 UTC, verify by 01-09 | Add a health check (proof: the nightly run)');
    assert.equal(formatVerifyRow(testTask({ status: 'verifying' }), TimeZone.UTC), 'T1 since 01-07 09:00 UTC, no verify-by date | Add a health check (proof: no proof named)');
  });

  it("names the proof once the verify-by day has come", () => {
    assert.equal(formatVerifyByLine(shipped, TimeZone.UTC), 'VERIFY T1 was to be verified by 01-09 (proof: the nightly run): done with the proof, or back to in-progress');
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
      task: { title: 'x', description: 'Why x.', owner: 'alpha', source: 'owner', ref: 'inbox:3', priority: 1, due: '2030-01-08', goals: ['G1'], noGoal: false, week: null, after: [], size: null, type: null, critical: false, pin: null, workClass: null, local: null },
    },
    { v: 1, type: 'create', id: 'T2', at: AT, by: 'lead', task: { title: 'y', description: null, owner: 'bravo', source: 'lead', ref: null, priority: 2, due: null, goals: [], noGoal: false, week: null, after: ['T1'], size: null, type: null, critical: false, pin: null, workClass: null, local: null } },
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
    assert.match(formatEvent(event, TimeZone.UTC), / bravo update note="context"$/);
  });

  it('prints a moved line with the team the task went to (T1144)', () => {
    const event: RegisterEvent = { v: 3, type: 'moved', id: 'T1', at: AT, by: 'lead', to: 'web' };
    assert.equal(formatEvent(event, TimeZone.UTC), '2030-01-07 09:00 UTC lead moved to=web');
  });

  it('prints each event type on one line', () => {
    assert.deepEqual(events.map((event) => formatEvent(event, TimeZone.UTC)), [
      '2030-01-07 09:00 UTC lead create owner=alpha source=owner priority=p1 ref=inbox:3 due=2030-01-08 goals=G1',
      '2030-01-07 09:00 UTC lead create owner=bravo source=lead priority=p2 after=T1',
      '2030-01-07 10:00 UTC lead update due=2030-01-09 goals=G1,G2 note="later"',
      '2030-01-07 11:00 UTC alpha status done note="ok" evidence=abc1234 skill=none',
      '2030-01-07 12:00 UTC bravo status waiting waits="decision owner · until Wed 01-09 12:00 UTC" note="n"',
      '2030-01-07 13:00 UTC lead update after=T1,T3',
    ]);
  });

  it('shows a task with its own history only', () => {
    const task = testTask({ status: 'done', ref: 'inbox:3', note: 'ok', evidence: 'abc1234', skill: 'none' });
    const detail = formatTaskDetail(task, events, TREE, EXTRAS).split('\n');
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
    assert.equal(formatEvent(proven, TimeZone.UTC), '2030-01-07 14:00 UTC alpha status verifying note="shipped" proof="the nightly run"');
    const detail = formatTaskDetail(testTask({ id: 'T3', status: 'verifying', note: 'shipped', proof: 'the nightly run' }), [proven], TREE, EXTRAS).split('\n');
    assert.deepEqual(detail.slice(1, 3), ['note: shipped', 'proof: the nightly run']);
  });

  it('shows the sighting a done task is watched for and its status line (T1306)', () => {
    const closed: RegisterEvent = { v: 2, type: 'status', id: 'T3', at: '2030-01-07T14:00:00.000Z', by: 'alpha', status: 'done', note: 'tests green', evidence: '6012 tests', skill: 'none', watch: 'the row shows' };
    assert.equal(formatEvent(closed, TimeZone.UTC), '2030-01-07 14:00 UTC alpha status done note="tests green" watch="the row shows" evidence=6012 tests skill=none');
    const detail = formatTaskDetail(testTask({ id: 'T3', status: 'done', note: 'tests green', evidence: '6012 tests', watch: 'the row shows' }), [closed], TREE, EXTRAS).split('\n');
    assert.deepEqual(detail.slice(1, 4), ['note: tests green', 'watch: the row shows', 'evidence: 6012 tests']);
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
    assert.equal(formatEvent(closed, TimeZone.UTC), '2030-01-07 14:00 UTC alpha status done note="ok" evidence=abc1234 skill=none followups=T4,T5');
    assert.match(formatEvent({ ...closed, followups: [] }, TimeZone.UTC), / skill=none followups=none$/);
    const task = testTask({ id: 'T3', status: 'done', note: 'ok', evidence: 'abc1234', skill: 'none', followups: ['T4', 'T5'] });
    assert.deepEqual(formatTaskDetail(task, [closed], TREE, EXTRAS).split('\n').slice(1, 6), ['note: ok', 'evidence: abc1234', 'skill: none', 'followups: T4, T5', 'history:']);
    assert.ok(!formatTaskDetail(testTask(), [], TREE, EXTRAS).includes('followups'), 'a task with none prints no line');
  });

  it('prints the files line after the fields, above the history, so a long history never buries it (T1457)', () => {
    const task = testTask({ id: 'T3', status: 'done', note: 'ok', evidence: 'abc1234', skill: 'none' });
    const files = 'files in /kit/teams/app/tasks/T3: design.md';
    assert.deepEqual(formatTaskDetail(task, [], TREE, { ...EXTRAS, files }).split('\n').slice(3, 6), ['skill: none', files, 'history:']);
    assert.ok(!formatTaskDetail(task, [], TREE, EXTRAS).includes('files in'), 'no line unless show gives one');
  });

  it('prints each hand step file an audit pins, before the card, and the audit in the history line (T2312)', () => {
    const pin = { path: '/w/tasks/T3/grant-read.ps1', sha256: 'c'.repeat(64) };
    const task = testTask({ id: 'T3', note: 'ready to ask', audits: [{ ...pin, by: 'gamma', at: '2030-01-07T14:00:00.000Z' }] });
    const lines = formatTaskDetail(task, [], TREE, EXTRAS).split('\n');
    assert.deepEqual(lines.slice(1, 3), ['note: ready to ask', 'audit: /w/tasks/T3/grant-read.ps1   (sha256 cccccccc, audited by gamma at 2030-01-07 14:00 UTC)']);
    const audited: RegisterEvent = { v: 2, type: 'update', id: 'T3', at: '2030-01-07T14:00:00.000Z', by: 'gamma', changes: {}, note: 'read it', audit: pin };
    assert.match(formatEvent(audited, TimeZone.UTC), / gamma update audit=\/w\/tasks\/T3\/grant-read\.ps1@cccccccc note="read it"$/);
    assert.ok(!formatTaskDetail(testTask({ id: 'T3' }), [], TREE, EXTRAS).includes('audit:'), 'a task with no audit prints no line');
  });

  it("prints a bug's review in show, a line per part given, and the parts a status line gave in the history", () => {
    const review = { cause: 'the parser skipped blank rows', missedLog: 'the skip logged nothing at all' };
    const reviewed: RegisterEvent = { v: 2, type: 'status', id: 'T3', at: '2030-01-07T14:00:00.000Z', by: 'alpha', status: 'in-progress', note: null, evidence: null, skill: null, review };
    assert.match(formatEvent(reviewed, TimeZone.UTC), / status in-progress review=cause,missed-log$/);
    const lines = formatTaskDetail(testTask({ id: 'T3', type: 'bug', review }), [], TREE, EXTRAS).split('\n');
    const at = lines.indexOf('review:');
    assert.deepEqual(lines.slice(at, at + 3), ['review:', '  cause: the parser skipped blank rows', '  missed by log: the skip logged nothing at all']);
    assert.ok(!formatTaskDetail(testTask({ type: 'bug' }), [], TREE, EXTRAS).includes('review:'), 'an unreviewed bug prints no review');
  });

  it('shows the description under the task line, its later lines indented and a blank one kept blank', () => {
    const task = testTask({ ref: 'inbox:3', description: 'Users lose saved carts.\n\nKeep them:\n- a week' });
    const detail = formatTaskDetail(task, [], TREE, EXTRAS).split('\n');
    assert.deepEqual(detail.slice(1, 7), ['description: Users lose saved carts.', '', '  Keep them:', '  - a week', 'ref: inbox:3', 'history:']);
    assert.ok(!formatTaskDetail(testTask(), [], TREE, EXTRAS).includes('description'), 'a task with none prints no line');
  });

  it('prints a changed description on one quoted line, cut, and a cleared one as none', () => {
    const changed = (description: string | null): RegisterEvent => ({ v: 2, type: 'update', id: 'T1', at: AT, by: 'alpha', changes: { description }, note: null });
    assert.equal(formatEvent(changed('Why:\nusers ask'), TimeZone.UTC), '2030-01-07 09:00 UTC alpha update description="Why: users ask"');
    assert.equal(formatEvent(changed(`${'d'.repeat(90)}`), TimeZone.UTC), `2030-01-07 09:00 UTC alpha update description="${'d'.repeat(79)}…"`);
    assert.equal(formatEvent(changed(null), TimeZone.UTC), '2030-01-07 09:00 UTC alpha update description=none');
  });

  it('prints a size as a percent of the weekly limit, on create, update and the detail', () => {
    const sized = testTask({ id: 'T1', size: 1.255 });
    const created: RegisterEvent = { v: 2, type: 'create', id: 'T1', at: AT, by: 'alpha', task: { ...sized, size: 1.5 } };
    assert.match(formatEvent(created, TimeZone.UTC), / size=1\.5%$/);
    const resized = (size: number | null): RegisterEvent => ({ v: 2, type: 'update', id: 'T1', at: AT, by: 'lead', changes: { size }, note: null });
    assert.equal(formatEvent(resized(0.5), TimeZone.UTC), '2030-01-07 09:00 UTC lead update size=0.5%');
    assert.equal(formatEvent(resized(null), TimeZone.UTC), '2030-01-07 09:00 UTC lead update size=none');
    assert.ok(formatTaskDetail(sized, [], TREE, EXTRAS).split('\n').includes('size: 1.25% of the weekly limit'));
    assert.ok(formatTaskDetail(sized, [], TREE, { ...EXTRAS, sizeCost: (pct) => `about ${pct * 2}M W` }).split('\n').includes('size: 1.25% of the weekly limit, about 2.51M W'));
    assert.ok(formatTaskDetail(sized, [], TREE, { ...EXTRAS, sizeCost: () => undefined }).split('\n').includes('size: 1.25% of the weekly limit'));
    assert.ok(!formatTaskDetail(testTask(), [], TREE, EXTRAS).includes('size'), 'a task with none prints no line');
    assert.deepEqual([sizeText(2), sizeText(0.125), sizeText(33.333)], ['2%', '0.13%', '33.33%']);
  });

  it('names a bug or critical bug on its row after the priority, never a task or an untyped one, and prints the type in the history', () => {
    assert.equal(formatTask(testTask({ type: 'bug', critical: true }), undefined, TREE), 'T1 open, p2, critical bug, owner alpha, from lead | Add a health check');
    assert.equal(formatTask(testTask({ type: 'bug' }), undefined, TREE), 'T1 open, p2, bug, owner alpha, from lead | Add a health check');
    const quiet: (ItemType | null)[] = ['task', null];
    for (const type of quiet) {
      assert.equal(formatTask(testTask({ type }), undefined, TREE), 'T1 open, p2, owner alpha, from lead | Add a health check', String(type));
    }
    const created: RegisterEvent = { v: 2, type: 'create', id: 'T1', at: AT, by: 'alpha', task: testTask({ id: 'T1', type: 'bug', critical: true }) };
    assert.match(formatEvent(created, TimeZone.UTC), / type=bug critical=true$/);
    const untyped: RegisterEvent = { v: 2, type: 'create', id: 'T1', at: AT, by: 'alpha', task: testTask({ id: 'T1' }) };
    assert.doesNotMatch(formatEvent(untyped, TimeZone.UTC), /type=|critical=/);
    const retyped: RegisterEvent = { v: 2, type: 'update', id: 'T1', at: AT, by: 'lead', changes: { type: 'task' }, note: null };
    assert.equal(formatEvent(retyped, TimeZone.UTC), '2030-01-07 09:00 UTC lead update type=task');
  });

  it('names a work class on its row after the goals, and prints it on create and its updates, a cleared one as none (T2076)', () => {
    assert.equal(formatTask(testTask({ workClass: 'Roadmap' }), undefined, TREE), 'T1 open, p2, owner alpha, from lead, class Roadmap | Add a health check');
    assert.equal(formatTask(testTask(), undefined, TREE), 'T1 open, p2, owner alpha, from lead | Add a health check', 'unset prints nothing');
    const classed = testTask({ workClass: 'Roadmap' });
    assert.doesNotMatch(formatTask(classed, undefined, rankedTree({ classes: { T1: 'Roadmap' } }, classed)), /class Roadmap/, 'a ranked row names it in its head, once');
    const created: RegisterEvent = { v: 2, type: 'create', id: 'T1', at: AT, by: 'alpha', task: testTask({ id: 'T1', workClass: 'Maintenance' }) };
    assert.match(formatEvent(created, TimeZone.UTC), / workClass=Maintenance$/);
    const reclassed = (workClass: string | null): RegisterEvent => ({ v: 2, type: 'update', id: 'T1', at: AT, by: 'lead', changes: { workClass }, note: null });
    assert.equal(formatEvent(reclassed('Improvements'), TimeZone.UTC), '2030-01-07 09:00 UTC lead update workClass=Improvements');
    assert.equal(formatEvent(reclassed(null), TimeZone.UTC), '2030-01-07 09:00 UTC lead update workClass=none');
  });

  it('names a pinned task on its row after the priority, and who pinned it in the detail and the history (T637)', () => {
    const pinned = testTask({ type: 'bug', pin: 'lead' });
    assert.equal(formatTask(pinned, undefined, TREE), 'T1 open, p2, pinned, bug, owner alpha, from lead | Add a health check');
    assert.ok(formatTaskDetail(pinned, [], TREE, EXTRAS).split('\n').includes('pinned by lead: above every other task of alpha'));
    assert.ok(!formatTaskDetail(testTask(), [], TREE, EXTRAS).includes('pinned'), 'an unpinned task prints no line');
    const pinning: RegisterEvent = { v: 2, type: 'update', id: 'T1', at: AT, by: 'lead', changes: { pin: 'lead' }, note: null };
    assert.equal(formatEvent(pinning, TimeZone.UTC), '2030-01-07 09:00 UTC lead update pin=lead');
  });

  it('prints goals none for a task said to serve no goal, on its row, its create and its updates (T1730)', () => {
    const offPlan = testTask({ id: 'T1', noGoal: true });
    assert.equal(formatTask(offPlan, undefined, TREE), 'T1 open, p2, owner alpha, from lead, goals none | Add a health check');
    assert.equal(formatTask(testTask({ id: 'T1' }), undefined, TREE), 'T1 open, p2, owner alpha, from lead | Add a health check', 'not said prints nothing');
    const created: RegisterEvent = { v: 2, type: 'create', id: 'T1', at: AT, by: 'alpha', task: offPlan };
    assert.equal(formatEvent(created, TimeZone.UTC), '2030-01-07 09:00 UTC alpha create owner=alpha source=lead priority=p2 goals=none');
    const update = (changes: Partial<TaskFields>): RegisterEvent => ({ v: 2, type: 'update', id: 'T1', at: AT, by: 'alpha', changes, note: null });
    assert.equal(formatEvent(update({ goals: [], noGoal: true }), TimeZone.UTC), '2030-01-07 09:00 UTC alpha update goals=none');
    assert.equal(formatEvent(update({ goals: ['A1'], noGoal: false }), TimeZone.UTC), '2030-01-07 09:00 UTC alpha update goals=A1');
    assert.equal(formatEvent(update({ goals: [] }), TimeZone.UTC), '2030-01-07 09:00 UTC alpha update goals=none', 'an older clear');
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
    assert.equal(assignedNotice(testTask({ id: 'T5', due: '2030-01-10' }), TimeZone.UTC), 'T5 is yours (p2, due 2030-01-10): Add a health check');
    assert.equal(assignedNotice(testTask({ id: 'T5', priority: 1 }), TimeZone.UTC), 'T5 is yours (p1): Add a health check');
  });
});

describe('askedNotice', () => {
  it("names the task, its owner, its priority and due date, its title, and how the lead reorders or reassigns it", () => {
    assert.equal(
      askedNotice(testTask({ id: 'T5', owner: 'front', due: '2030-01-10' }), TimeZone.UTC),
      'T5 went to front (p2, due 2030-01-10): Add a health check; reorder or reassign it: teamrig update T5 --priority|--after|--owner',
    );
    assert.match(askedNotice(testTask({ id: 'T5', owner: 'front', priority: 1 }), TimeZone.UTC), /^T5 went to front \(p1\): Add a health check; /);
  });
});

describe('personWaitNotice: the card', () => {
  it("names the card's question, so the line reads on its own", () => {
    const task = testTask({ id: 'T2', note: 'asked again', card: TEST_CARD });
    assert.equal(personWaitNotice(task, [{ kind: 'decision', who: 'owner' }], 'lead'), "T2 waits on the owner's decision: Which pricing tier ships first");
  });
});

describe("the views in the team's zone", () => {
  it('ends a bare due day at midnight there and reads a stored minute as UTC', () => {
    assert.equal(dueTime({ due: '2030-01-09' }, JERUSALEM), Date.parse('2030-01-09T21:59:59.999Z'));
    assert.equal(dueTime({ due: '2030-01-09 21:00' }, JERUSALEM), Date.parse('2030-01-09T21:00:00.000Z'));
  });

  it('orders a bare day by its end there', () => {
    const day = { id: 'T3', priority: 2, due: '2030-01-09' };
    const minute = { id: 'T4', priority: 2, due: '2030-01-09 22:30' };
    assert.deepEqual([day, minute].sort((a, b) => byPlanOrder(a, b, TimeZone.UTC)).map((row) => row.id), ['T4', 'T3']);
    assert.deepEqual([minute, day].sort((a, b) => byPlanOrder(a, b, JERUSALEM)).map((row) => row.id), ['T3', 'T4'], 'the day ends at 22:00 UTC there');
  });

  it('prints an event minute there, zone-marked', () => {
    const event: RegisterEvent = { v: 1, type: 'update', id: 'T1', at: AT, by: 'bravo', changes: {}, note: 'context' };
    assert.match(formatEvent(event, JERUSALEM), /^2030-01-07 11:00 IST bravo update /);
  });
});

describe("the line a parent team's lead gets when its task ends (T509)", () => {
  it('names the task <team>/<id>, a done one with its evidence and a dropped one with its note, each on one line', () => {
    const task = testTask({ id: 'T4', title: 'Ship login', evidence: 'PR #12\nmerged', note: 'shipped' });
    assert.equal(endedNotice({ ...task, status: 'done' }, 'web'), 'web/T4 done: Ship login | evidence: PR #12 merged');
    assert.equal(endedNotice({ ...task, status: 'dropped', note: 'not  needed' }, 'web'), 'web/T4 dropped: Ship login | note: not needed');
  });

  it('ends at the title when the team asks no evidence on done', () => {
    assert.equal(endedNotice(testTask({ id: 'T4', title: 'Ship login', status: 'done', evidence: null }), 'web'), 'web/T4 done: Ship login');
  });
});

describe('the answer to an approval (T684)', () => {
  const answer ={ verdict: 'approved' as const, by: 'lead', at: '2030-01-07T14:00:00.000Z', note: 'tests green, small commits' };

  it("tells the task's owner to push or merge on an approval, and to fix and ask again on a decline, each on one line", () => {
    assert.equal(
      approvalNotice(testTask({ id: 'T2' }), { ...answer, note: 'tests  green,\nsmall commits' }),
      'lead approved T2: tests green, small commits; push or merge it now, then set its next status',
    );
    assert.equal(
      approvalNotice(testTask({ id: 'T2' }), { ...answer, verdict: 'declined', note: 'no tests' }),
      'lead declined T2: no tests; set it in-progress, fix that, then ask again (--status waiting --waits approval:lead)',
    );
  });

  it('shows the answer on the waiting row and in show, and the verdict in the history', () => {
    const task = testTask({ status: 'waiting', waits: [{ kind: 'approval', who: 'lead' }], note: 'branch t1', answer });
    assert.match(formatTask(task, undefined, TREE), /\(waiting: approval lead · lead approved; branch t1\)/);
    const event: RegisterEvent = { v: 2, type: 'update', id: 'T1', at: answer.at, by: 'lead', changes: {}, note: 'tests green', verdict: 'approved' };
    const detail = formatTaskDetail(task, [event], TREE, EXTRAS);
    assert.match(detail, /^answer: lead approved at 2030-01-07 14:00 UTC: tests green, small commits$/m);
    assert.match(detail, / lead update verdict=approved note="tests green"$/m);
  });
});

describe("the owner's decision a leader recorded (T1366)", () => {
  const decided = { by: 'lead', at: '2030-01-07T14:00:00.000Z', note: 'human decided: ship it' };

  it('shows it on the waiting row, with or without a wait left, in show, and the mark in the history', () => {
    const task = testTask({ status: 'waiting', waits: [], note: 'branch t1', decided });
    assert.match(formatTask(task, undefined, TREE), /\(waiting: owner decided, by lead; branch t1\)/);
    assert.match(formatTask({ ...task, waits: [{ kind: 'task', id: 'T2' }] }, undefined, TREE), /\(waiting: on T2 ready · owner decided, by lead; branch t1\)/);
    const event: RegisterEvent = { v: 2, type: 'update', id: 'T1', at: decided.at, by: 'lead', changes: {}, note: decided.note, waits: [], decided: true };
    const detail = formatTaskDetail(task, [event], TREE, EXTRAS);
    assert.match(detail, /^decided: lead at 2030-01-07 14:00 UTC: human decided: ship it$/m);
    assert.match(detail, / lead update decided note="human decided: ship it"$/m);
  });
});
