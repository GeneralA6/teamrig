import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_OWNER_SOURCE, testRanking } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import type { Band } from './score.ts';
import {
  decidingKey,
  needPath,
  needsElsewhere,
  needsOf,
  NO_TASKS_ELSEWHERE,
  pathText,
  planOrder,
  readAs,
  TaskTree,
  type PlanPlace,
  type RankedPlace,
  type TaskElsewhere,
  type TasksElsewhere,
  type TreeRanking,
  type TreeTask,
} from './tree.ts';
import { isReady } from './waits.ts';
import { TimeZone } from '../core/zone.ts';

const NOW = new Date('2030-01-08T10:00:00.000Z');

function treeOf(...tasks: Task[]): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC);
}

function ids(tasks: readonly Pick<Task, 'id'>[]): string[] {
  return tasks.map((task) => task.id);
}

describe('needsOf', () => {
  it('lists the tasks it comes after, then the tasks it waits on, each once', () => {
    const task = testTask({ status: 'waiting', after: ['T3', 'T2'], waits: [{ kind: 'task', id: 'T2' }, { kind: 'decision', who: 'lead' }, { kind: 'task', id: 'T9' }] });
    assert.deepEqual(needsOf(task), ['T3', 'T2', 'T9']);
    assert.deepEqual(needsOf(testTask()), []);
  });
});

describe('needsElsewhere', () => {
  const byId = (...tasks: readonly Task[]): ReadonlyMap<string, Task> => new Map(tasks.map((task) => [task.id, task]));

  it('is true only when an active task comes after or waits on an id the tasks lack', () => {
    const home = testTask({ id: 'T2' });
    assert.equal(needsElsewhere(byId(home, testTask({ id: 'T3', after: ['T2'], waits: [{ kind: 'decision', who: 'lead' }] }))), false);
    assert.equal(needsElsewhere(byId(home, testTask({ id: 'T3', after: ['T9'] }))), true);
    assert.equal(needsElsewhere(byId(home, testTask({ id: 'T3', status: 'waiting', waits: [{ kind: 'task', id: 'T9' }] }))), true);
    assert.equal(needsElsewhere(byId(home, testTask({ id: 'T3', status: 'done', after: ['T9'] }))), false, 'a finished task needs nothing');
    assert.equal(needsElsewhere(byId()), false);
  });
});

describe('needPath', () => {
  const tasks = new Map([
    ['T1', testTask({ id: 'T1', after: ['T2'] })],
    ['T2', testTask({ id: 'T2', status: 'waiting', waits: [{ kind: 'task', id: 'T3' }] })],
    ['T3', testTask({ id: 'T3', status: 'done', after: ['T4'] })],
    ['T5', testTask({ id: 'T5', after: ['T3', 'T1'] })],
  ]);

  it('finds the shortest chain along after links and task waits, through tasks of any status', () => {
    assert.deepEqual(needPath(tasks, 'T1', 'T4'), ['T1', 'T2', 'T3', 'T4']);
    assert.deepEqual(needPath(tasks, 'T5', 'T3'), ['T5', 'T3']);
  });

  it('is the task alone when both ends are one task, and undefined when nothing leads there', () => {
    assert.deepEqual(needPath(tasks, 'T2', 'T2'), ['T2']);
    assert.equal(needPath(tasks, 'T4', 'T1'), undefined);
    assert.equal(needPath(tasks, 'T9', 'T1'), undefined);
  });

  it('prints a chain with arrows', () => {
    assert.equal(pathText(['T2', 'T194', 'T2']), 'T2 -> T194 -> T2');
  });
});

describe('planOrder', () => {
  it('orders places with no ranking by deadline with none last, then id number', () => {
    const places = [
      { id: 'T10', at: undefined },
      { id: 'T3', at: 200 },
      { id: 'T2', at: undefined },
      { id: 'T4', at: 100 },
      { id: 'T8', at: 100 },
    ];
    assert.deepEqual(ids([...places].sort(planOrder)), ['T4', 'T8', 'T3', 'T2', 'T10']);
  });

  /** Two places due at 100, T9 and the lower-numbered T3, each with the given fields over that. */
  const pair = (ahead: Partial<PlanPlace>, behind: Partial<PlanPlace> = {}): [PlanPlace, PlanPlace] => [
    { id: 'T9', at: 100, ...ahead },
    { id: 'T3', at: 100, ...behind },
  ];

  /** A place's rank in the given band at the given score. */
  const rank = (band: Band, score: number): RankedPlace => ({ band, score, costOfDelay: score, sizePct: 1, workClass: 'Roadmap', goal: null });

  it('decides on the first key that differs, each in turn', () => {
    const cases: [string, [PlanPlace, PlanPlace]][] = [
      ['pinned', pair({ pinned: true, ranked: rank(2, 1), at: 900 }, { ranked: rank(0, 99), started: true })],
      ['band', pair({ ranked: rank(0, 1), at: 900 }, { ranked: rank(1, 99), started: true, pinned: false })],
      ['band', pair({ ranked: rank(1, 1) }, { ranked: rank(2, 99) })],
      ['band', pair({ ranked: rank(2, 1) })],
      ['score', pair({ ranked: rank(1, 20), at: 900 }, { ranked: rank(1, 10), started: true })],
      ['started', pair({ ranked: rank(1, 10), started: true, at: 900 }, { ranked: rank(1, 10), started: false })],
      ['started', pair({ started: true, at: 900 }, { started: false })],
      ['due', pair({ at: 50 }, { unblocks: { first: 'T1', priority: 1, count: 3 } })],
      ['due', pair({}, { at: undefined })],
      ['unblocks', pair({ unblocks: { first: 'T1', priority: 1, count: 1 } }, { unblocks: { first: 'T2', priority: 2, count: 4 }, inWeek: true })],
      ['unblocks', pair({ unblocks: { first: 'T1', priority: 2, count: 2 } }, { unblocks: { first: 'T2', priority: 2, count: 1 } })],
      ['unblocks', pair({ unblocks: { first: 'T1', priority: 3, count: 1 } })],
      ['week', pair({ inWeek: true }, { inWeek: false, size: 1 })],
      ['size', pair({ size: 1 }, { size: 5 })],
      ['size', pair({ size: 5 }, { size: null })],
    ];
    for (const [key, [ahead, behind]] of cases) {
      assert.equal(decidingKey(ahead, behind), key, `${key}: ${JSON.stringify(ahead)}`);
      assert.ok(planOrder(ahead, behind) < 0 && planOrder(behind, ahead) > 0, key);
    }
  });

  it('falls back to age, and ties a place with itself', () => {
    const [late, early] = pair({});
    assert.equal(decidingKey(late, early), 'age');
    assert.ok(planOrder(early, late) < 0);
    assert.equal(decidingKey(late, { ...late }), undefined);
    assert.equal(planOrder(late, { ...late }), 0);
  });
});

describe('TaskTree ranking', () => {
  const ranked = (ranking: TreeRanking, ...tasks: Task[]): TaskTree => new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC, null, NO_TASKS_ELSEWHERE, ranking);
  const costOf = (tree: TaskTree, task: Task): number | undefined => tree.rankedOf(task)?.costOfDelay;

  it('puts an expedite ahead of a far higher score', () => {
    const ordered = testTask({ id: 'T9', source: TEST_OWNER_SOURCE, priority: 1, size: 10 });
    const roadmap = testTask({ id: 'T3', size: 0.3 });
    const tree = ranked(testRanking({ classes: { T3: 'Roadmap' }, goals: { T3: { tag: 'G1', rank: 1 } } }), ordered, roadmap);
    assert.deepEqual(ids(tree.inPlanOrder([roadmap, ordered])), ['T9', 'T3']);
    assert.ok((tree.rankedOf(ordered)?.score ?? 0) < (tree.rankedOf(roadmap)?.score ?? 0));
  });

  it('puts a higher score ahead of an in-progress task, and an older number never decides first', () => {
    const open = testTask({ id: 'T9' });
    const started = testTask({ id: 'T3', status: 'in-progress' });
    const tree = ranked(testRanking({ classes: { T9: 'Roadmap', T3: 'Roadmap' }, goals: { T9: { tag: 'G1', rank: 1 } } }), open, started);
    assert.deepEqual(ids(tree.inPlanOrder([started, open])), ['T9', 'T3']);
  });

  it('leaves equal scores to the keys below them', () => {
    const open = testTask({ id: 'T3' });
    const started = testTask({ id: 'T9', status: 'in-progress' });
    assert.deepEqual(ids(ranked(testRanking(), open, started).inPlanOrder([open, started])), ['T9', 'T3']);
  });

  it('gives no weight to a priority no owner ordered', () => {
    const urgent = testTask({ id: 'T9', priority: 1 });
    const plain = testTask({ id: 'T3', priority: 3 });
    assert.deepEqual(ids(ranked(testRanking(), urgent, plain).inPlanOrder([urgent, plain])), ['T3', 'T9']);
  });

  it('scores a task once per tree, however often a sort reads it', () => {
    let reads = 0;
    const base = testRanking();
    const counted: TreeRanking = { ...base, sizingOf: (task) => { reads += 1; return base.sizingOf(task); } };
    const tasks = [testTask({ id: 'T1' }), testTask({ id: 'T2' }), testTask({ id: 'T3' })];
    const tree = ranked(counted, ...tasks);
    tree.inPlanOrder(tasks);
    tree.inPlanOrder(tasks);
    assert.equal(reads, tasks.length);
  });

  it('adds a share of the best value among the active tasks that need it', () => {
    const work = testTask({ id: 'T3' });
    const roadmap = testTask({ id: 'T7', after: ['T3'] });
    const tooling = testTask({ id: 'T8', after: ['T3'] });
    const finished = testTask({ id: 'T9', status: 'done', after: ['T3'] });
    const facts = { classes: { T7: 'Roadmap', T9: 'Roadmap' }, goals: { T7: { tag: 'G2', rank: 2 }, T9: { tag: 'G1', rank: 1 } } };
    assert.equal(costOf(ranked(testRanking(facts), work, roadmap, tooling, finished), work), 1 + 0.5 * 16);
  });

  it('counts no need on a finished task', () => {
    const work = testTask({ id: 'T3', status: 'done' });
    const needer = testTask({ id: 'T7', after: ['T3'] });
    assert.equal(costOf(ranked(testRanking({ classes: { T7: 'Roadmap' } }), work, needer), work), 1);
  });

  it('dates a task by its effective due', () => {
    const work = testTask({ id: 'T3' });
    const needer = testTask({ id: 'T7', after: ['T3'], due: '2030-01-09' });
    assert.equal(costOf(ranked(testRanking(), work, needer), work), 1 + 4 + 0.5);
  });

  it('keeps the class and goal it read, and an owner order only from the owner', () => {
    const goal = { tag: 'A1', rank: 1 };
    const task = testTask({ id: 'T3', source: TEST_OWNER_SOURCE, priority: 2 });
    const tree = ranked(testRanking({ classes: { T3: 'Roadmap' }, goals: { T3: goal } }), task);
    assert.deepEqual({ workClass: tree.rankedOf(task)?.workClass, goal: tree.rankedOf(task)?.goal, cost: costOf(tree, task) }, { workClass: 'Roadmap', goal, cost: 20 + 6 });
    const other = testTask({ id: 'T4', source: 'alpha', priority: 2 });
    assert.equal(costOf(ranked(testRanking(), other), other), 1);
  });

  it('has no rank with no ranking, and places such a task with none', () => {
    const task = testTask({ id: 'T3' });
    const tree = treeOf(task);
    assert.equal(tree.rankedOf(task), undefined);
    assert.equal(tree.placeOf(task).ranked, undefined);
  });
});

describe('TaskTree needs and neededBy', () => {
  it('reads both directions, the needers active only and by number', () => {
    const tree = treeOf(
      testTask({ id: 'T1' }),
      testTask({ id: 'T12', after: ['T1'] }),
      testTask({ id: 'T3', status: 'in-progress', waits: [] }),
      testTask({ id: 'T4', status: 'waiting', waits: [{ kind: 'task', id: 'T1' }] }),
      testTask({ id: 'T5', status: 'done', after: ['T1'] }),
    );
    assert.deepEqual(tree.needs('T4'), ['T1']);
    assert.deepEqual(tree.needs('T99'), []);
    assert.deepEqual(ids(tree.neededBy('T1')), ['T4', 'T12']);
    assert.deepEqual(tree.neededBy('T3'), []);
  });
});

describe('TaskTree neededByOthers', () => {
  const tree = treeOf(
    testTask({ id: 'T1', owner: 'alpha' }),
    testTask({ id: 'T2', owner: 'alpha', due: '2030-01-09', after: ['T1'] }),
    testTask({ id: 'T3', owner: 'bravo', due: '2030-01-12', after: ['T1'] }),
    testTask({ id: 'T4', owner: 'charlie', due: '2030-01-10', status: 'waiting', waits: [{ kind: 'task', id: 'T1' }] }),
    testTask({ id: 'T5', owner: 'bravo', due: '2030-01-09', status: 'done', after: ['T1'] }),
    testTask({ id: 'T6', owner: 'delta', after: ['T1'] }),
    testTask({ id: 'T7', owner: 'echo', after: ['T1'] }),
    testTask({ id: 'T8', owner: 'bravo', status: 'done' }),
    testTask({ id: 'T9', owner: 'alpha', after: ['T8'] }),
  );

  it('lists the active needers of other owners, the earliest effective due first, then in plan order', () => {
    assert.deepEqual(ids(tree.neededByOthers('T1')), ['T4', 'T3', 'T6', 'T7']);
  });

  it('is empty for a finished task, one the read lacks, and one only its owner needs', () => {
    assert.deepEqual(tree.neededByOthers('T8'), []);
    assert.deepEqual(tree.neededByOthers('T99'), []);
    assert.deepEqual(tree.neededByOthers('T2'), []);
  });
});

describe('TaskTree over a reader\'s rows', () => {
  /** A row as a reader keeps it: the fields the tree reads and one of its own, none of teamrig's others. */
  type Row = TreeTask & { readonly label: string };
  const row = (fields: Partial<Row> & Pick<Row, 'id'>): Row => ({ status: 'open', owner: 'alpha', priority: 2, due: null, after: [], waits: [], label: `row ${fields.id}`, ...fields });
  const rows: TaskTree<Row> = new TaskTree(
    new Map(
      [
        row({ id: 'T1', owner: 'alpha' }),
        row({ id: 'T2', owner: 'bravo', due: '2030-01-10', after: ['T1'] }),
        row({ id: 'T3', owner: 'alpha', status: 'in-progress', priority: 1 }),
      ].map((task) => [task.id, task]),
    ),
    NOW, TimeZone.UTC,
  );

  it('hands back the reader\'s own rows, with their own fields', () => {
    assert.deepEqual(rows.neededByOthers('T1').map((needer) => needer.label), ['row T2']);
    assert.equal(rows.task('T2')?.label, 'row T2');
    assert.deepEqual(rows.effectiveDue('T1'), { due: '2030-01-10', at: Date.UTC(2030, 0, 10, 23, 59, 59, 999), from: 'T2' });
    const move = rows.nextMove('T2');
    assert.equal(move?.task.label, 'row T1');
    assert.equal(move?.behind?.label, 'row T3');
    assert.deepEqual(rows.waitingOn('alpha').map((entry) => entry.task.label), ['row T2']);
    assert.deepEqual(rows.inPlanOrder(rows.neededBy('T1')).map((needer) => needer.label), ['row T2']);
  });

  it('places a row without week or size as untagged and unsized', () => {
    assert.equal(rows.week, null);
    const { inWeek, size, unblocks } = rows.placeOf(row({ id: 'T1' }));
    assert.deepEqual({ inWeek, size, unblocks }, { inWeek: false, size: null, unblocks: { first: 'T2', priority: 2, count: 1 } });
  });
});

describe('TaskTree effectiveDue', () => {
  it('inherits the earliest due of the active tasks that need it, directly or not, naming where it comes from', () => {
    const tree = treeOf(
      testTask({ id: 'T1', due: '2030-01-20' }),
      testTask({ id: 'T2', after: ['T1'] }),
      testTask({ id: 'T3', after: ['T2'], due: '2030-01-12' }),
      testTask({ id: 'T4', after: ['T2'], due: '2030-01-15 09:00' }),
      testTask({ id: 'T5', status: 'dropped', after: ['T1'], due: '2030-01-09' }),
    );
    assert.deepEqual(tree.effectiveDue('T1'), { due: '2030-01-12', at: Date.parse('2030-01-12T23:59:59.999Z'), from: 'T3' });
    assert.equal(tree.effectiveDue('T2')?.from, 'T3');
    assert.deepEqual(tree.effectiveDue('T4'), { due: '2030-01-15 09:00', at: Date.parse('2030-01-15T09:00:00.000Z'), from: null });
    assert.equal(tree.dueTime(testTask({ id: 'T1' })), Date.parse('2030-01-12T23:59:59.999Z'));
  });

  it('keeps its own due on a tie, and a finished task keeps its own due only', () => {
    const tree = treeOf(
      testTask({ id: 'T1', due: '2030-01-12' }),
      testTask({ id: 'T2', after: ['T1'], due: '2030-01-12' }),
      testTask({ id: 'T3', status: 'done', due: '2030-01-30' }),
      testTask({ id: 'T4', status: 'waiting', startedAt: '2030-01-07T09:00:00.000Z', waits: [{ kind: 'task', id: 'T3' }], due: '2030-01-10' }),
    );
    assert.equal(tree.effectiveDue('T1')?.from, null);
    assert.deepEqual(tree.effectiveDue('T3'), { due: '2030-01-30', at: Date.parse('2030-01-30T23:59:59.999Z'), from: null });
  });

  it('is undefined with no date anywhere, for a task the read lacks, and for an unreadable due', () => {
    const tree = treeOf(testTask({ id: 'T1' }), testTask({ id: 'T2', after: ['T1'], due: 'soon' }));
    assert.equal(tree.effectiveDue('T1'), undefined);
    assert.equal(tree.effectiveDue('T2'), undefined);
    assert.equal(tree.effectiveDue('T9'), undefined);
    assert.equal(tree.dueTime(testTask({ id: 'T9', due: '2030-01-10' })), Date.parse('2030-01-10T23:59:59.999Z'), 'a task the read lacks keeps its own due');
  });

  it('ends on a loop, each task read once', () => {
    const tree = treeOf(testTask({ id: 'T1', after: ['T2'] }), testTask({ id: 'T2', after: ['T1'], due: '2030-01-11' }), testTask({ id: 'T3', after: ['T1'], due: '2030-01-10' }));
    assert.equal(tree.effectiveDue('T1')?.from, 'T3');
    assert.equal(tree.effectiveDue('T2')?.from, 'T3');
  });
});

describe('TaskTree plan order', () => {
  it('sorts on effective dues', () => {
    const tree = treeOf(testTask({ id: 'T2' }), testTask({ id: 'T3', due: '2030-01-15' }), testTask({ id: 'T4', after: ['T2'], due: '2030-01-10' }));
    const tasks = [testTask({ id: 'T3', due: '2030-01-15' }), testTask({ id: 'T2' }), testTask({ id: 'T4', after: ['T2'], due: '2030-01-10' })];
    assert.deepEqual(ids(tree.inPlanOrder(tasks)), ['T2', 'T4', 'T3']);
  });

  it('with no ranking keeps a started task on top, then reads due, need, week and size, whatever the priority', () => {
    const tasks = [
      testTask({ id: 'T1', due: '2030-01-09' }),
      testTask({ id: 'T2', status: 'in-progress' }),
      testTask({ id: 'T3' }),
      testTask({ id: 'T4', week: '2030-01-07' }),
      testTask({ id: 'T5', size: 2 }),
      testTask({ id: 'T6', size: 1 }),
      testTask({ id: 'T7', priority: 1, after: ['T3'] }),
      testTask({ id: 'T8', priority: 1, status: 'in-progress' }),
    ];
    assert.deepEqual(ids(treeOf(...tasks).inPlanOrder(tasks)), ['T2', 'T8', 'T1', 'T3', 'T4', 'T6', 'T5', 'T7']);
  });
});

describe('TaskTree unblocks and placeOf', () => {
  const tree = treeOf(
    testTask({ id: 'T1', status: 'in-progress', week: '2030-01-07', size: 3 }),
    testTask({ id: 'T5', priority: 3, after: ['T1'] }),
    testTask({ id: 'T7', priority: 1, waits: [{ kind: 'task', id: 'T1' }], status: 'waiting' }),
    testTask({ id: 'T6', priority: 1, after: ['T1'] }),
    testTask({ id: 'T8', status: 'done', priority: 1, after: ['T2'] }),
    testTask({ id: 'T2', week: '2030-01-14' }),
    testTask({ id: 'T3', status: 'done', after: ['T2'] }),
    testTask({ id: 'T4', status: 'done' }),
    testTask({ id: 'T9', after: ['T4'] }),
  );

  it('names the first needer of the best priority and counts every active needer', () => {
    assert.deepEqual(tree.unblocks('T1'), { first: 'T6', priority: 1, count: 3 });
    assert.equal(tree.unblocks('T2'), undefined, 'only finished tasks need it');
    assert.equal(tree.unblocks('T4'), undefined, 'a finished task unblocks nothing');
    assert.equal(tree.unblocks('T99'), undefined);
  });

  it('places a task on every key, in the week plan in force by default', () => {
    assert.equal(tree.week, '2030-01-07', 'T2\'s week has not started');
    assert.deepEqual(tree.placeOf(testTask({ id: 'T1', status: 'in-progress', week: '2030-01-07', size: 3 })), {
      id: 'T1', pinned: false, ranked: undefined, at: undefined, started: true, unblocks: { first: 'T6', priority: 1, count: 3 }, inWeek: true, size: 3,
    });
    assert.deepEqual(tree.placeOf(testTask({ id: 'T2', week: '2030-01-14' })), {
      id: 'T2', pinned: false, ranked: undefined, at: undefined, started: false, unblocks: undefined, inWeek: false, size: null,
    });
    assert.equal(tree.placeOf(testTask({ id: 'T2', pin: 'lead' })).pinned, true);
  });

  it('reads the week it is given, null for none', () => {
    const tasks = new Map([testTask({ id: 'T2', week: '2030-01-14' })].map((task) => [task.id, task]));
    assert.equal(new TaskTree(tasks, NOW, TimeZone.UTC, '2030-01-14').placeOf(testTask({ id: 'T2', week: '2030-01-14' })).inWeek, true);
    assert.equal(new TaskTree(tasks, NOW, TimeZone.UTC, null).week, null);
    assert.equal(new TaskTree(tasks, NOW, TimeZone.UTC, null).placeOf(testTask({ id: 'T2', week: '2030-01-14' })).inWeek, false);
  });
});

describe('TaskTree nextMove', () => {
  const started = '2030-01-07T09:00:00.000Z';

  it('is the owner of the first unfinished need in plan order that needs nothing unfinished', () => {
    const tree = treeOf(
      testTask({ id: 'T1', owner: 'alpha', after: ['T2', 'T3', 'T6'] }),
      testTask({ id: 'T2', owner: 'bravo' }),
      testTask({ id: 'T3', owner: 'charlie', due: '2030-01-09', after: ['T4'] }),
      testTask({ id: 'T4', owner: 'delta', status: 'in-progress' }),
      testTask({ id: 'T6', status: 'done' }),
    );
    const move = tree.nextMove('T1');
    assert.equal(move?.kind, 'work');
    assert.equal(move?.who, 'delta');
    assert.equal(move?.task.id, 'T4');
    assert.equal(move?.behind, undefined);
  });

  it('is the task owner when nothing it needs is unfinished, and undefined for a finished or unknown task', () => {
    const tree = treeOf(testTask({ id: 'T1', owner: 'alpha', after: ['T2', 'T7'] }), testTask({ id: 'T2', status: 'done' }));
    assert.equal(tree.nextMove('T1')?.who, 'alpha');
    assert.equal(tree.nextMove('T2'), undefined);
    assert.equal(tree.nextMove('T9'), undefined);
  });

  it('names who must give a pending decision or approval, before a time to come', () => {
    const tree = treeOf(
      testTask({ id: 'T1', status: 'waiting', startedAt: started, waits: [{ kind: 'time', at: '2030-01-09 12:00' }, { kind: 'approval', who: 'lead' }] }),
      testTask({ id: 'T2', status: 'waiting', startedAt: started, waits: [{ kind: 'time', at: '2030-01-09 12:00' }] }),
      testTask({ id: 'T3', status: 'waiting', startedAt: started, waits: [{ kind: 'time', at: '2030-01-01' }, { kind: 'task', id: 'T4' }] }),
      testTask({ id: 'T4', status: 'done' }),
    );
    assert.deepEqual(tree.nextMove('T1'), { kind: 'approval', who: 'lead', task: testTask({ id: 'T1', status: 'waiting', startedAt: started, waits: [{ kind: 'time', at: '2030-01-09 12:00' }, { kind: 'approval', who: 'lead' }] }), behind: undefined });
    const time = tree.nextMove('T2');
    assert.equal(time?.kind, 'time');
    assert.equal(time?.kind === 'time' ? time.at : undefined, '2030-01-09 12:00');
    assert.equal(time?.who, 'alpha');
    assert.equal(tree.nextMove('T3')?.kind, 'work', 'every reason ready: the owner goes on');
  });

  it('says what the mover works first when it holds an in-progress task of a higher priority', () => {
    const tree = treeOf(
      testTask({ id: 'T1', owner: 'alpha', priority: 1, after: ['T2'] }),
      testTask({ id: 'T2', owner: 'bravo', priority: 3 }),
      testTask({ id: 'T7', owner: 'bravo', priority: 2, status: 'in-progress' }),
      testTask({ id: 'T8', owner: 'bravo', priority: 1, status: 'in-progress', due: '2030-01-09' }),
      testTask({ id: 'T9', owner: 'bravo', priority: 3, status: 'in-progress' }),
      testTask({ id: 'T10', owner: 'bravo', priority: 1, status: 'open' }),
    );
    assert.equal(tree.nextMove('T1')?.behind?.id, 'T8');
    assert.equal(tree.nextMove('T8')?.behind, undefined);
  });

  it('skips a loop for another branch, and is undefined when every branch loops', () => {
    const looping = treeOf(testTask({ id: 'T1', after: ['T2'] }), testTask({ id: 'T2', after: ['T3'] }), testTask({ id: 'T3', after: ['T2'] }));
    assert.equal(looping.nextMove('T1'), undefined);
    const branching = treeOf(
      testTask({ id: 'T1', after: ['T2', 'T4'] }),
      testTask({ id: 'T2', priority: 1, after: ['T3'] }),
      testTask({ id: 'T3', after: ['T2'] }),
      testTask({ id: 'T4', owner: 'bravo' }),
    );
    assert.equal(branching.nextMove('T1')?.task.id, 'T4');
  });
});

describe("TaskTree over a team tree's other registers", () => {
  const started = '2030-01-07T09:00:00.000Z';
  const away = (team: string, task: Task): [string, TaskElsewhere] => [task.id, { team, task }];
  const elsewhere: TasksElsewhere = new Map([
    away('web', testTask({ id: 'T20', owner: 'lead', status: 'in-progress' })),
    away('web', testTask({ id: 'T21', status: 'done' })),
    away('ops', testTask({ id: 'T1', owner: 'lead' })),
  ]);
  const tasks = [
    testTask({ id: 'T1', owner: 'alpha', status: 'waiting', startedAt: started, waits: [{ kind: 'task', id: 'T20' }] }),
    testTask({ id: 'T2', owner: 'alpha', after: ['T21'] }),
    testTask({ id: 'T3', owner: 'alpha', after: ['T20', 'T4'] }),
    testTask({ id: 'T4', owner: 'bravo' }),
  ];
  const tree = new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC, undefined, elsewhere);

  it("waits on another register's unfinished task, whose owner there moves, and goes on once it finished", () => {
    assert.equal(isReady({ kind: 'task', id: 'T20' }, tree.context), false);
    const move = tree.nextMove('T1');
    assert.deepEqual(move?.kind === 'elsewhere' ? [move.who, move.team, move.need.id, move.task.id] : move, ['lead', 'web', 'T20', 'T1']);
    assert.deepEqual(tree.nextMove('T2'), { kind: 'work', who: 'alpha', task: tree.task('T2'), behind: undefined });
  });

  it("moves on the read's own unfinished needs first", () => {
    assert.equal(tree.nextMove('T3')?.who, 'bravo');
    assert.equal(tree.nextMove('T3')?.task.id, 'T4');
  });

  it('reads an id elsewhere only when the read lacks it', () => {
    assert.equal(tree.elsewhereOf('T20')?.team, 'web');
    assert.equal(tree.elsewhereOf('T1'), undefined, 'a register numbered before its tree keeps its own T1');
    assert.equal(tree.elsewhereOf('T99'), undefined);
  });

  it('reads every id it lacks as retired outside a tree', () => {
    const alone = new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC);
    assert.equal(isReady({ kind: 'task', id: 'T20' }, alone.context), true);
    assert.equal(alone.nextMove('T1')?.kind, 'work');
  });
});

describe('readAs', () => {
  it("reads the tree as another team's register does: the holder's tasks, every other register's elsewhere", () => {
    const own = [testTask({ id: 'T1', owner: 'front' }), testTask({ id: 'T5', owner: 'front' })];
    const elsewhere: TasksElsewhere = new Map([
      ['T2', { team: 'app', task: testTask({ id: 'T2', owner: 'lead' }) }],
      ['T3', { team: 'ops', task: testTask({ id: 'T3', owner: 'run' }) }],
      ['T5', { team: 'ops', task: testTask({ id: 'T5', owner: 'run' }) }],
    ]);
    const read = readAs('app', 'web', own, elsewhere);
    assert.deepEqual([...read.tasks.keys()], ['T2']);
    assert.deepEqual(
      [...read.elsewhere].map(([id, away]) => `${away.team}/${id} ${away.task.owner}`),
      ['web/T1 front', 'web/T5 front', 'ops/T3 run'],
      "the reader's own task wins an id another register holds too",
    );
  });
});

describe('TaskTree waitingOn', () => {
  it('lists the active tasks of other owners that need its unfinished tasks or wait on its decision, in plan order', () => {
    const started = '2030-01-07T09:00:00.000Z';
    const tree = treeOf(
      testTask({ id: 'T1', owner: 'alpha' }),
      testTask({ id: 'T2', owner: 'alpha', status: 'in-progress' }),
      testTask({ id: 'T3', owner: 'alpha', status: 'done' }),
      testTask({ id: 'T4', owner: 'bravo', after: ['T1', 'T2', 'T3'] }),
      testTask({ id: 'T5', owner: 'bravo', due: '2030-01-09', status: 'waiting', startedAt: started, waits: [{ kind: 'decision', who: 'alpha' }, { kind: 'approval', who: 'lead' }] }),
      testTask({ id: 'T6', owner: 'alpha', after: ['T1'] }),
      testTask({ id: 'T7', owner: 'bravo', status: 'done', after: ['T1'] }),
      testTask({ id: 'T8', owner: 'bravo', after: ['T3'] }),
    );
    const waiting = tree.waitingOn('alpha');
    assert.deepEqual(ids(waiting.map((entry) => entry.task)), ['T5', 'T4']);
    assert.deepEqual(waiting[0]?.asks, [{ kind: 'decision', who: 'alpha' }]);
    assert.deepEqual(ids(waiting[1]?.needs ?? []), ['T2', 'T1'], 'the started need first');
    assert.deepEqual(tree.waitingOn('charlie'), []);
  });
});

describe('TaskTree loops', () => {
  it('names each loop among active tasks once, from its lowest task, by the shortest chain back', () => {
    const tree = treeOf(
      testTask({ id: 'T2', after: ['T194'] }),
      testTask({ id: 'T194', status: 'waiting', startedAt: '2030-01-07T09:00:00.000Z', waits: [{ kind: 'task', id: 'T2' }] }),
      testTask({ id: 'T5', after: ['T6'] }),
      testTask({ id: 'T6', after: ['T7'] }),
      testTask({ id: 'T7', after: ['T5', 'T6'] }),
      testTask({ id: 'T8', after: ['T9'] }),
      testTask({ id: 'T9', status: 'done', after: ['T8'] }),
    );
    assert.deepEqual(tree.loops(), [['T2', 'T194', 'T2'], ['T5', 'T6', 'T7', 'T5']]);
  });

  it('is empty without a loop', () => {
    assert.deepEqual(treeOf(testTask({ id: 'T1', after: ['T2'] }), testTask({ id: 'T2' })).loops(), []);
  });
});
