import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOCUS } from '../config/defaults.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { TimeZone } from '../core/zone.ts';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import { likeMedians, likeSizing, likeTasksOf, ownSizing, storedSizing, treeRanking, type Sizing, type SpendKey } from './ranking.ts';
import { TaskTree } from './tree.ts';

const NOW = Date.parse('2030-01-20T10:00:00.000Z');

/** A task done `daysAgo` days before NOW. */
function done(id: string, daysAgo: number, fields: Partial<Task> = {}): Task {
  return testTask({ id, status: 'done', statusAt: new Date(NOW - daysAgo * MS_PER_DAY).toISOString(), workClass: 'Roadmap', type: 'task', ...fields });
}

function sizingOver(tasks: readonly Task[], spends: Readonly<Record<string, number>>): Sizing {
  return likeSizing(tasks, DEFAULT_FOCUS, ({ id }) => spends[id] ?? 0, NOW);
}

const LIKE = testTask({ id: 'T9', workClass: 'Roadmap', type: 'task' });

describe('treeRanking (T2076)', () => {
  const ranking = treeRanking({ focus: DEFAULT_FOCUS, ownerSource: 'owner', goals: new Map(), sizing: ownSizing });

  it("hands on the team's focus and owner marker", () => {
    assert.equal(ranking.focus, DEFAULT_FOCUS);
    assert.equal(ranking.ownerSource, 'owner');
  });

  it("reads a row's class, and one with none as the default class", () => {
    assert.equal(ranking.classOf(testTask({ workClass: 'Roadmap' })), 'Roadmap');
    assert.equal(ranking.classOf({ id: 'T2', status: 'open', owner: 'alpha', priority: 2, due: null, after: [], waits: [] }), 'Improvements');
  });

  it('sizes through the sizing it was given', () => {
    assert.deepEqual(ranking.sizingOf(testTask({ size: 2 })), { size: 2, spentPct: 0, likeMedianPct: undefined });
  });

  it('ranks a tree: a Roadmap task over an unclassed one of a better priority', () => {
    const tasks = [testTask({ id: 'T1', priority: 1 }), testTask({ id: 'T2', priority: 3, workClass: 'Roadmap' })];
    const tree = new TaskTree(new Map(tasks.map((task) => [task.id, task])), new Date(NOW), TimeZone.UTC, undefined, undefined, ranking);
    assert.deepEqual([...tasks].sort((a, b) => tree.byPlanOrder(a, b)).map((task) => task.id), ['T2', 'T1']);
  });

  it('values a Roadmap task by the goal it serves, and names the goal that holds the rank', () => {
    const goals = new Map([['A1', { parent: null, rank: 1 }], ['A1.1', { parent: 'A1', rank: null }]]);
    const ranked = treeRanking({ focus: DEFAULT_FOCUS, ownerSource: 'owner', goals, sizing: ownSizing });
    const task = testTask({ id: 'T1', workClass: 'Roadmap', goals: ['A1.1'] });
    const plain = testTask({ id: 'T2', workClass: 'Roadmap' });
    const tree = new TaskTree(new Map([[task.id, task], [plain.id, plain]]), new Date(NOW), TimeZone.UTC, undefined, undefined, ranked);
    assert.deepEqual(tree.rankedOf(task)?.goal, { tag: 'A1', rank: 1 });
    assert.equal(tree.rankedOf(plain)?.goal, null);
    assert.ok((tree.rankedOf(task)?.score ?? 0) > (tree.rankedOf(plain)?.score ?? 0));
  });

  it('reads a row with no goals as serving none', () => {
    const goals = new Map([['A1', { parent: null, rank: 1 }]]);
    const ranked = treeRanking({ focus: DEFAULT_FOCUS, ownerSource: 'owner', goals, sizing: ownSizing });
    assert.equal(ranked.goalOf({ id: 'T2', status: 'open', owner: 'alpha', priority: 2, due: null, after: [], waits: [] }), null);
  });
});

describe('ownSizing (T2076)', () => {
  it("reads only the task's own size", () => {
    assert.deepEqual(ownSizing({ size: 1.5 }), { size: 1.5, spentPct: 0, likeMedianPct: undefined });
    assert.deepEqual(ownSizing({}), { size: null, spentPct: 0, likeMedianPct: undefined });
  });
});

describe('likeSizing (T2076)', () => {
  it("hands on the task's own size and spend", () => {
    assert.deepEqual(sizingOver([], { T9: 0.4 })(testTask({ id: 'T9', size: 2 })), { size: 2, spentPct: 0.4, likeMedianPct: undefined });
  });

  it("reads a task's own spend from its size base, and a like task's whole cost (T2109)", () => {
    const sizeBase = { day: '2030-01-19', w: 5 };
    const asked: SpendKey[] = [];
    const sizing = likeSizing([done('T1', 1, { sizeBase })], DEFAULT_FOCUS, (task) => {
      asked.push(task);
      return 1;
    }, NOW);
    sizing(testTask({ id: 'T9', size: 2, sizeBase }));
    sizing(testTask({ id: 'T8' }));
    assert.deepEqual(asked, [{ id: 'T1', sizeBase: null }, { id: 'T9', sizeBase }, { id: 'T8', sizeBase: null }]);
  });

  it('reads a row with no size base from its whole cost', () => {
    const asked: SpendKey[] = [];
    likeSizing([], DEFAULT_FOCUS, (task) => {
      asked.push(task);
      return 0;
    }, NOW)({ id: 'T2', status: 'open', owner: 'alpha', priority: 2, due: null, after: [], waits: [] });
    assert.deepEqual(asked, [{ id: 'T2', sizeBase: null }]);
  });

  it('is the median spend of done tasks of the same class and type', () => {
    const tasks = [done('T1', 1), done('T2', 2), done('T3', 3)];
    assert.equal(sizingOver(tasks, { T1: 0.1, T2: 0.9, T3: 0.2 })(LIKE).likeMedianPct, 0.2);
  });

  it('keeps fractions of a percent, between the two middle spends of an even count', () => {
    assert.equal(sizingOver([done('T1', 1), done('T2', 2)], { T1: 0.1, T2: 0.2 })(LIKE).likeMedianPct, 0.15000000000000002);
  });

  it('counts neither another class nor another type', () => {
    const tasks = [done('T1', 1, { workClass: 'Maintenance' }), done('T2', 1, { type: 'bug' })];
    assert.equal(sizingOver(tasks, { T1: 1, T2: 1 })(LIKE).likeMedianPct, undefined);
  });

  it("reads an unclassed task as the default class on both sides", () => {
    const sizing = sizingOver([done('T1', 1, { workClass: null })], { T1: 0.7 });
    assert.equal(sizing(testTask({ id: 'T9', workClass: 'Improvements', type: 'task' })).likeMedianPct, 0.7);
    assert.equal(sizing(testTask({ id: 'T9', workClass: null, type: 'task' })).likeMedianPct, 0.7);
  });

  it('counts a task done exactly 14 days ago and none before it', () => {
    assert.equal(sizingOver([done('T1', 14)], { T1: 0.5 })(LIKE).likeMedianPct, 0.5);
    assert.equal(sizingOver([done('T1', 14.01)], { T1: 0.5 })(LIKE).likeMedianPct, undefined);
  });

  it('leaves out a dropped task and one still open: neither is a size of finished work', () => {
    const tasks = [done('T1', 1, { status: 'dropped' }), done('T2', 1, { status: 'in-progress' })];
    assert.equal(sizingOver(tasks, { T1: 1, T2: 1 })(LIKE).likeMedianPct, undefined);
  });

  it('leaves out a task with no spend: 0 is unmetered, not free', () => {
    assert.equal(sizingOver([done('T1', 1), done('T2', 2), done('T3', 3)], { T1: 0.6 })(LIKE).likeMedianPct, 0.6);
  });

  it("reads each like task's spend once, not once per task sized", () => {
    const reads: string[] = [];
    const sizing = likeSizing([done('T1', 1)], DEFAULT_FOCUS, ({ id }) => {
      reads.push(id);
      return 1;
    }, NOW);
    sizing(LIKE);
    sizing(LIKE);
    assert.equal(reads.filter((id) => id === 'T1').length, 1);
  });
});

describe('likeTasksOf (T2194)', () => {
  it('keeps the tasks done inside the window, with only what the medians read', () => {
    const tasks = [done('T1', 1, { owner: 'alpha', size: 2 }), done('T2', 14.01), done('T3', 1, { status: 'dropped' }), done('T4', 1, { status: 'open' })];
    assert.deepEqual(likeTasksOf(tasks, NOW), [{ id: 'T1', status: 'done', statusAt: new Date(NOW - MS_PER_DAY).toISOString(), workClass: 'Roadmap', type: 'task' }]);
  });

  it('sizes as the whole register does, read later', () => {
    const tasks = [done('T1', 1), done('T2', 13), done('T3', 20)];
    const spends: Readonly<Record<string, number>> = { T1: 0.2, T2: 0.4, T3: 0.9 };
    const later = NOW + 2 * MS_PER_DAY;
    const kept = likeTasksOf(tasks, NOW);
    assert.deepEqual(likeMedians(kept, DEFAULT_FOCUS, (id) => spends[id] ?? 0, later), likeMedians(tasks, DEFAULT_FOCUS, (id) => spends[id] ?? 0, later));
  });
});

describe('likeMedians (T2194)', () => {
  const spends: Readonly<Record<string, number>> = { T1: 0.1, T2: 0.3, T3: 0.5, T4: 0.7, T5: 0.2 };
  const spentOf = (id: string): number => spends[id] ?? 0;

  it('lists each kind with its median, by class and then type, an unset type first', () => {
    const tasks = [done('T1', 1, { type: 'bug' }), done('T2', 1), done('T3', 1, { type: null }), done('T4', 1, { workClass: 'Maintenance' }), done('T5', 1, { type: 'bug' })];
    assert.deepEqual(likeMedians(tasks, DEFAULT_FOCUS, spentOf, NOW), [
      { workClass: 'Maintenance', type: 'task', pct: 0.7 },
      { workClass: 'Roadmap', type: null, pct: 0.5 },
      { workClass: 'Roadmap', type: 'bug', pct: 0.15000000000000002 },
      { workClass: 'Roadmap', type: 'task', pct: 0.3 },
    ]);
  });

  it('names an unclassed kind by the default class, and lists no kind with no spend', () => {
    const tasks = [done('T1', 1, { workClass: null }), done('T9', 1, { workClass: 'Maintenance' })];
    assert.deepEqual(likeMedians(tasks, DEFAULT_FOCUS, spentOf, NOW), [{ workClass: DEFAULT_FOCUS.defaultClass, type: 'task', pct: 0.1 }]);
  });
});

describe('storedSizing (T2194)', () => {
  const tasks = [done('T1', 1), done('T2', 2), done('T3', 3, { type: 'bug' }), done('T4', 1, { workClass: null, type: null })];
  const spends: Readonly<Record<string, number>> = { T1: 0.1, T2: 0.3, T3: 0.25, T4: 0.6, T8: 0.05 };
  const spentOf = (id: string): number => spends[id] ?? 0;
  const stored = { spentPct: spends, likeMedians: likeMedians(tasks, DEFAULT_FOCUS, spentOf, NOW) };
  const rows = [
    LIKE,
    testTask({ id: 'T8', workClass: 'Roadmap', type: 'bug', size: 1 }),
    testTask({ id: 'T7', workClass: null, type: null }),
    testTask({ id: 'T6', workClass: 'Maintenance', type: 'task' }),
    { id: 'T5', status: 'open' as const, owner: 'alpha', priority: 2, due: null, after: [], waits: [] },
  ];

  it('sizes each row as likeSizing does on the same spend', () => {
    const live = likeSizing(tasks, DEFAULT_FOCUS, ({ id }) => spentOf(id), NOW);
    const read = storedSizing(stored, DEFAULT_FOCUS);
    assert.deepEqual(rows.map(read), rows.map(live));
  });

  it("reads a task's spend from its entry, and one with none as 0", () => {
    const read = storedSizing(stored, DEFAULT_FOCUS);
    assert.equal(read(testTask({ id: 'T8', sizeBase: { day: '2030-01-19', w: 5 } })).spentPct, 0.05);
    assert.equal(read(testTask({ id: 'T99' })).spentPct, 0);
  });

  it('takes no entry for an inherited key', () => {
    assert.equal(storedSizing(stored, DEFAULT_FOCUS)(testTask({ id: 'constructor' })).spentPct, 0);
  });
});
