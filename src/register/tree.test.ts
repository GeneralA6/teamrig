import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import { needPath, needsOf, pathText, planOrder, TaskTree } from './tree.ts';

const NOW = new Date('2030-01-08T10:00:00.000Z');

function treeOf(...tasks: Task[]): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW);
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
  it('orders by priority, then deadline with none last, then id number', () => {
    const places = [
      { id: 'T10', priority: 2, at: undefined },
      { id: 'T3', priority: 2, at: 200 },
      { id: 'T2', priority: 2, at: undefined },
      { id: 'T4', priority: 2, at: 100 },
      { id: 'T7', priority: 1, at: undefined },
      { id: 'T8', priority: 2, at: 100 },
    ];
    assert.deepEqual(ids([...places].sort(planOrder)), ['T7', 'T4', 'T8', 'T3', 'T2', 'T10']);
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
    testTask({ id: 'T6', owner: 'delta', priority: 3, after: ['T1'] }),
    testTask({ id: 'T7', owner: 'echo', priority: 1, after: ['T1'] }),
    testTask({ id: 'T8', owner: 'bravo', status: 'done' }),
    testTask({ id: 'T9', owner: 'alpha', after: ['T8'] }),
  );

  it('lists the active needers of other owners, the earliest effective due first, then in plan order', () => {
    assert.deepEqual(ids(tree.neededByOthers('T1')), ['T4', 'T3', 'T7', 'T6']);
  });

  it('is empty for a finished task, one the read lacks, and one only its owner needs', () => {
    assert.deepEqual(tree.neededByOthers('T8'), []);
    assert.deepEqual(tree.neededByOthers('T99'), []);
    assert.deepEqual(tree.neededByOthers('T2'), []);
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
});

describe('TaskTree nextMove', () => {
  const started = '2030-01-07T09:00:00.000Z';

  it('is the owner of the first unfinished need in plan order that needs nothing unfinished', () => {
    const tree = treeOf(
      testTask({ id: 'T1', owner: 'alpha', after: ['T2', 'T3', 'T6'] }),
      testTask({ id: 'T2', owner: 'bravo', priority: 3 }),
      testTask({ id: 'T3', owner: 'charlie', priority: 2, after: ['T4'] }),
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

describe('TaskTree waitingOn', () => {
  it('lists the active tasks of other owners that need its unfinished tasks or wait on its decision, in plan order', () => {
    const started = '2030-01-07T09:00:00.000Z';
    const tree = treeOf(
      testTask({ id: 'T1', owner: 'alpha' }),
      testTask({ id: 'T2', owner: 'alpha', status: 'in-progress' }),
      testTask({ id: 'T3', owner: 'alpha', status: 'done' }),
      testTask({ id: 'T4', owner: 'bravo', priority: 3, after: ['T1', 'T2', 'T3'] }),
      testTask({ id: 'T5', owner: 'bravo', priority: 1, status: 'waiting', startedAt: started, waits: [{ kind: 'decision', who: 'alpha' }, { kind: 'approval', who: 'lead' }] }),
      testTask({ id: 'T6', owner: 'alpha', after: ['T1'] }),
      testTask({ id: 'T7', owner: 'bravo', status: 'done', after: ['T1'] }),
      testTask({ id: 'T8', owner: 'bravo', after: ['T3'] }),
    );
    const waiting = tree.waitingOn('alpha');
    assert.deepEqual(ids(waiting.map((entry) => entry.task)), ['T5', 'T4']);
    assert.deepEqual(waiting[0]?.asks, [{ kind: 'decision', who: 'alpha' }]);
    assert.deepEqual(ids(waiting[1]?.needs ?? []), ['T1', 'T2']);
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
