import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOCUS } from '../config/defaults.ts';
import { testTask } from '../testing/task.ts';
import { classOf, rankOf, type RankedGoal } from './focus.ts';

describe('classOf (T2076)', () => {
  it("reads a task's own class, and one with none as the team's default class", () => {
    assert.equal(classOf(testTask({ workClass: 'Roadmap' }), DEFAULT_FOCUS), 'Roadmap');
    assert.equal(classOf(testTask({ workClass: null }), DEFAULT_FOCUS), 'Improvements');
    assert.equal(classOf(testTask(), { defaultClass: 'Chores' }), 'Chores');
  });

  it('keeps a class the team has since renamed out of focus.classes, as written', () => {
    assert.equal(classOf(testTask({ workClass: 'Tech debt' }), DEFAULT_FOCUS), 'Tech debt');
  });
});

describe('rankOf (T2083)', () => {
  const goal = (parent: string | null, rank: number | null): RankedGoal => ({ parent, rank });
  // A1 ranks 2 with an unranked key result A1.1 and its part A1.1.1; B1 ranks 1; C1 is unranked, its part C1.1 ranks 5.
  const goals: ReadonlyMap<string, RankedGoal> = new Map([
    ['A1', goal(null, 2)],
    ['A1.1', goal('A1', null)],
    ['A1.1.1', goal('A1.1', null)],
    ['B1', goal(null, 1)],
    ['C1', goal(null, null)],
    ['C1.1', goal('C1', 5)],
  ]);

  it("reads a goal's own rank, and a key result's from up its parent chain", () => {
    assert.equal(rankOf(testTask({ goals: ['A1'] }), goals), 2);
    assert.equal(rankOf(testTask({ goals: ['A1.1.1'] }), goals), 2);
    assert.equal(rankOf(testTask({ goals: ['C1.1'] }), goals), 5);
  });

  it('takes the best rank of every goal a task names', () => {
    assert.equal(rankOf(testTask({ goals: ['A1.1', 'B1', 'C1.1'] }), goals), 1);
  });

  it('reads null for no goal, an unknown goal or an unranked chain', () => {
    assert.equal(rankOf(testTask({ goals: [] }), goals), null);
    assert.equal(rankOf(testTask({ goals: ['Z9'] }), goals), null);
    assert.equal(rankOf(testTask({ goals: ['C1'] }), goals), null);
  });

  it('ends on a parent loop in a damaged goals map', () => {
    const looped: ReadonlyMap<string, RankedGoal> = new Map([
      ['A1', goal('A1.1', null)],
      ['A1.1', goal('A1', 3)],
    ]);
    assert.equal(rankOf(testTask({ goals: ['A1'] }), looped), 3);
  });
});
