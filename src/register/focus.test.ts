import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOCUS } from '../config/defaults.ts';
import { testTask } from '../testing/task.ts';
import { classOf, goalChain, prepStanding, rankOf, servedGoalOf, type RankedGoal, type SlicedGoal } from './focus.ts';

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

describe('goalChain (T2092)', () => {
  const goal = (parent: string | null, rank: number | null): RankedGoal => ({ parent, rank });
  const tags = (tag: string, goals: ReadonlyMap<string, RankedGoal>): string[] => goalChain(tag, goals).map(([at]) => at);

  it('walks a goal up its parents, nearest first, each with its record', () => {
    const top = goal(null, 1);
    const part = goal('A1', null);
    assert.deepEqual(
      goalChain(
        'A1.1',
        new Map([
          ['A1', top],
          ['A1.1', part],
        ]),
      ),
      [
        ['A1.1', part],
        ['A1', top],
      ],
    );
  });

  it('is empty for a tag the team holds no goal for, and ends at a parent it does not hold', () => {
    assert.deepEqual(tags('Z9', new Map()), []);
    assert.deepEqual(tags('A1.1', new Map([['A1.1', goal('A1', null)]])), ['A1.1']);
  });

  it('walks each goal once on a parent loop in a damaged goals map', () => {
    const looped = new Map([
      ['A1', goal('A1.1', null)],
      ['A1.1', goal('A1', 3)],
    ]);
    assert.deepEqual(tags('A1', looped), ['A1', 'A1.1']);
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

  it('names the goal that holds the best rank, not the one the task names', () => {
    assert.deepEqual(servedGoalOf(testTask({ goals: ['A1.1.1'] }), goals), { tag: 'A1', rank: 2 });
    assert.deepEqual(servedGoalOf(testTask({ goals: ['A1.1', 'B1', 'C1.1'] }), goals), { tag: 'B1', rank: 1 });
    assert.equal(servedGoalOf(testTask({ goals: ['C1'] }), goals), null);
  });
});

describe('prepStanding (T2453)', () => {
  const goal = (parent: string | null, rank: number | null, slice: number | null): SlicedGoal => ({ parent, rank, slice });
  const goals: ReadonlyMap<string, SlicedGoal> = new Map([
    ['A1', goal(null, 1, 2)],
    ['A1.1', goal('A1', null, 3)],
    ['B1', goal(null, null, 2)],
    ['C1', goal(null, 2, null)],
  ]);
  const standing = (tag: string, slice: number): ReturnType<typeof prepStanding> => prepStanding(testTask({ prepares: { goal: tag, slice } }), goals);

  it("is near for the ranked goal's open slice or the next one, a rank up the parent chain counting", () => {
    assert.equal(standing('A1', 2), 'near');
    assert.equal(standing('A1', 3), 'near');
    assert.equal(standing('A1.1', 4), 'near', 'its own slice, its parent rank');
  });

  it('lapses for a slice past the next or one already shipped, an unranked goal, a goal with no slice open or one gone', () => {
    assert.equal(standing('A1', 5), 'lapsed');
    assert.equal(standing('A1', 1), 'lapsed');
    assert.equal(standing('B1', 2), 'lapsed', 'unranked');
    assert.equal(standing('C1', 1), 'lapsed', 'no slice open');
    assert.equal(standing('Z9', 1), 'lapsed', 'no such goal');
  });

  it('is null for a task with no marker', () => {
    assert.equal(prepStanding(testTask(), goals), null);
  });
});
