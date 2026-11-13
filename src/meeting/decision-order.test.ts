import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOCUS } from '../config/defaults.ts';
import { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import type { SlicedGoal } from '../register/focus.ts';
import { ownSizing, treeRanking } from '../register/ranking.ts';
import { TaskTree } from '../register/tree.ts';
import { testTask } from '../testing/task.ts';
import { decisionOrder, isImprovementsDay, unblockedBy, type Decision, type DecisionRead } from './decision-order.ts';

const NOW = new Date('2030-01-08T10:00:00Z');

const DECISION_WAIT = { status: 'waiting', waits: [{ kind: 'decision', who: 'owner' }] } as const;

function treeOf(tasks: readonly Task[], goals: ReadonlyMap<string, SlicedGoal> = new Map()): TaskTree {
  const ranking = treeRanking({ focus: DEFAULT_FOCUS, ownerSource: 'owner', goals, sizing: ownSizing });
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC, null, undefined, ranking);
}

/** A register's read whose decisions are `decisions`, among `others`. */
function readOf(decisions: readonly Task[], others: readonly Task[] = [], team?: string, goals?: ReadonlyMap<string, SlicedGoal>): DecisionRead {
  return { tasks: decisions, tree: treeOf([...decisions, ...others], goals), team, focus: DEFAULT_FOCUS };
}

function ids(decisions: readonly Decision[]): string[] {
  return decisions.map(({ task, team }) => (team === undefined ? task.id : `${team}/${task.id}`));
}

describe('unblockedBy (T2092)', () => {
  it('holds the task and every active task that needs it, directly or not', () => {
    const decide = testTask({ id: 'T1', ...DECISION_WAIT });
    const direct = testTask({ id: 'T2', after: ['T1'] });
    const further = testTask({ id: 'T3', after: ['T2'] });
    const finished = testTask({ id: 'T4', after: ['T1'], status: 'done' });
    const other = testTask({ id: 'T5' });
    const tree = treeOf([decide, direct, further, finished, other]);
    assert.deepEqual(
      unblockedBy(decide, tree).map((task) => task.id),
      ['T1', 'T2', 'T3'],
    );
  });

  it('ends on a loop of needs, each task once', () => {
    const one = testTask({ id: 'T1', after: ['T2'] });
    const two = testTask({ id: 'T2', after: ['T1'] });
    assert.deepEqual(
      unblockedBy(one, treeOf([one, two])).map((task) => task.id),
      ['T1', 'T2'],
    );
  });
});

describe('decisionOrder (T2092)', () => {
  it('puts a decision that frees Roadmap work ahead of one that frees Maintenance, whatever the scores', () => {
    const maintenance = testTask({ id: 'T1', ...DECISION_WAIT, workClass: 'Maintenance', type: 'bug', critical: false, size: 0.1 });
    const roadmap = testTask({ id: 'T2', ...DECISION_WAIT, workClass: 'Maintenance', size: 50 });
    const freed = testTask({ id: 'T3', workClass: 'Roadmap', after: ['T2'], size: 50 });
    assert.deepEqual(ids(decisionOrder([readOf([maintenance, roadmap], [freed])]).daily), ['T2', 'T1']);
  });

  it('puts an expedite ahead of Roadmap work', () => {
    const roadmap = testTask({ id: 'T1', ...DECISION_WAIT, workClass: 'Roadmap' });
    const expedite = testTask({ id: 'T2', ...DECISION_WAIT, workClass: 'Improvements', priority: 0 });
    assert.deepEqual(ids(decisionOrder([readOf([roadmap, expedite])]).daily), ['T2', 'T1']);
  });

  it('ranks by the best score over the tasks a decision unblocks, through a chain of needs', () => {
    const goals = new Map<string, SlicedGoal>([['A1', { parent: null, rank: 1, slice: null }]]);
    const plain = testTask({ id: 'T1', ...DECISION_WAIT, workClass: 'Roadmap' });
    const freeing = testTask({ id: 'T2', ...DECISION_WAIT, workClass: 'Roadmap' });
    const middle = testTask({ id: 'T3', workClass: 'Roadmap', after: ['T2'] });
    const ranked = testTask({ id: 'T4', workClass: 'Roadmap', goals: ['A1'], after: ['T3'] });
    assert.deepEqual(ids(decisionOrder([readOf([plain, freeing], [middle, ranked], undefined, goals)]).daily), ['T2', 'T1']);
  });

  it('merges the teams into one list, a better decision below ahead of a worse one of the own team', () => {
    const own = testTask({ id: 'T1', ...DECISION_WAIT, workClass: 'Maintenance' });
    const web = testTask({ id: 'T7', ...DECISION_WAIT, workClass: 'Roadmap' });
    assert.deepEqual(ids(decisionOrder([readOf([own]), readOf([web], [], 'web')]).daily), ['web/T7', 'T1']);
  });

  it('keeps the order handed in on a tie, the own team first', () => {
    const first = testTask({ id: 'T2', ...DECISION_WAIT });
    const second = testTask({ id: 'T1', ...DECISION_WAIT });
    const web = testTask({ id: 'T7', ...DECISION_WAIT });
    assert.deepEqual(ids(decisionOrder([readOf([first, second]), readOf([web], [], 'web')]).daily), ['T2', 'T1', 'web/T7']);
  });

  it("hands back the read of the register that holds each decision", () => {
    const web = readOf([testTask({ id: 'T7', ...DECISION_WAIT })], [], 'web');
    const [decision] = decisionOrder([readOf([]), web]).daily;
    assert.equal(decision?.tree, web.tree);
  });

  it('keeps a tree with no ranking in the order handed in', () => {
    const tasks = [testTask({ id: 'T2', ...DECISION_WAIT }), testTask({ id: 'T1', ...DECISION_WAIT })];
    const tree = new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC);
    assert.deepEqual(ids(decisionOrder([{ tasks, tree, team: undefined, focus: DEFAULT_FOCUS }]).daily), ['T2', 'T1']);
  });
});

describe('the weekly Improvements batch (T2092)', () => {
  const improvements = { ...DECISION_WAIT, workClass: 'Improvements' } as const;

  it('holds a decision whose tasks all have a class other than Roadmap and Maintenance', () => {
    const decide = testTask({ id: 'T1', ...improvements });
    const tooling = testTask({ id: 'T2', workClass: 'Tooling', after: ['T1'] });
    const order = decisionOrder([readOf([decide], [tooling])]);
    assert.deepEqual([ids(order.daily), ids(order.improvements)], [[], ['T1']]);
  });

  // Read as the default class, every unclassed decision would vanish until the batch day.
  it('keeps a decision with no stored class on the daily, even though it reads as the default class', () => {
    const order = decisionOrder([readOf([testTask({ id: 'T1', ...DECISION_WAIT, workClass: null })])]);
    assert.deepEqual([ids(order.daily), ids(order.improvements)], [['T1'], []]);
  });

  it('keeps a decision on the daily when a task it unblocks has no stored class', () => {
    const decide = testTask({ id: 'T1', ...improvements });
    const unclassed = testTask({ id: 'T2', workClass: null, after: ['T1'] });
    assert.deepEqual(ids(decisionOrder([readOf([decide], [unclassed])]).daily), ['T1']);
  });

  it('keeps a decision on the daily when it unblocks Roadmap or Maintenance work', () => {
    const decide = testTask({ id: 'T1', ...improvements });
    const roadmap = testTask({ id: 'T2', workClass: 'Roadmap', after: ['T1'] });
    const other = testTask({ id: 'T3', ...improvements });
    const maintenance = testTask({ id: 'T4', workClass: 'Maintenance', after: ['T3'] });
    assert.deepEqual(ids(decisionOrder([readOf([decide, other], [roadmap, maintenance])]).daily), ['T1', 'T3']);
  });

  it('keeps an expedite on the daily, and one that frees an expedite', () => {
    const expedite = testTask({ id: 'T1', ...improvements, priority: 0 });
    const freeing = testTask({ id: 'T2', ...improvements });
    const freed = testTask({ id: 'T3', workClass: 'Improvements', priority: 0, after: ['T2'] });
    assert.deepEqual(ids(decisionOrder([readOf([expedite, freeing], [freed])]).daily).sort(), ['T1', 'T2']);
  });

  it("reads each register's class names from its own focus", () => {
    const decide = testTask({ id: 'T1', ...DECISION_WAIT, workClass: 'Improvements' });
    const renamed: DecisionRead = { ...readOf([decide]), focus: { roadmapClass: 'Improvements', maintenanceClass: 'Upkeep' } };
    assert.deepEqual(ids(decisionOrder([renamed]).daily), ['T1']);
  });

  it('orders the batch as the daily is ordered', () => {
    const plain = testTask({ id: 'T1', ...improvements, size: 50 });
    const cheap = testTask({ id: 'T2', ...improvements, size: 0.5 });
    assert.deepEqual(ids(decisionOrder([readOf([plain, cheap])]).improvements), ['T2', 'T1']);
  });
});

describe('isImprovementsDay (T2092)', () => {
  it('reads the weekday on UTC, the day turning at midnight UTC', () => {
    assert.equal(isImprovementsDay(Date.parse('2030-01-08T23:30:00Z'), 'tue'), true);
    assert.equal(isImprovementsDay(Date.parse('2030-01-08T23:30:00Z'), 'wed'), false);
    assert.equal(isImprovementsDay(Date.parse('2030-01-09T00:30:00Z'), 'wed'), true);
  });
});
