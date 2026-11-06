import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testRanking } from '../testing/ranking.ts';
import { testTask } from '../testing/task.ts';
import { fitLines, leftOfWeek, overLimitFlag, weekFit, type FitRow } from './fit.ts';
import type { Task } from './fold.ts';
import { TaskTree, type TreeRanking } from './tree.ts';
import { TimeZone } from '../core/zone.ts';

const week = '2030-01-07';
const NOW = new Date('2030-01-08T10:00:00.000Z');

function treeOf(tasks: readonly Task[] = [], ranking?: TreeRanking): TaskTree {
  return new TaskTree(new Map(tasks.map((task) => [task.id, task])), NOW, TimeZone.UTC, undefined, undefined, ranking);
}

function rankedRows(ranking: TreeRanking | undefined, ...tasks: Parameters<typeof testTask>[0][]): FitRow[] {
  const all = tasks.map((fields) => testTask({ week, ...fields }));
  const tree = treeOf(all, ranking);
  return all.map((task) => ({ task, tree }));
}

function rows(...tasks: Parameters<typeof testTask>[0][]): FitRow[] {
  return rankedRows(undefined, ...tasks);
}

describe('leftOfWeek', () => {
  it('is the pace target less the week used, never below 0', () => {
    assert.equal(leftOfWeek(99.5, 81), 18.5);
    assert.equal(leftOfWeek(99.5, 100), 0);
  });
});

describe('weekFit', () => {
  it('sums the sized to-do tasks per priority in plan order and names the first past the line', () => {
    // Scores: T2 20/3, T3 (16 + 4 due soon)/5, T1 10/4; T4 and T5 sit a band below.
    const ranking = testRanking({
      classes: { T1: 'Maintenance', T2: 'Roadmap', T3: 'Roadmap' },
      goals: { T2: { tag: 'G1', rank: 1 }, T3: { tag: 'G2', rank: 2 } },
    });
    const fit = weekFit(
      rankedRows(
        ranking,
        { id: 'T1', priority: 2, size: 4 },
        { id: 'T2', priority: 1, size: 3, status: 'in-progress' },
        { id: 'T3', priority: 2, size: 5, due: '2030-01-08' },
        { id: 'T4', priority: 3, size: 1 },
        { id: 'T5', priority: 2 },
      ),
      week,
      10,
    );
    assert.deepEqual([...fit.fits], [[1, 3], [2, 5]]);
    assert.equal(fit.unfit?.row.task.id, 'T1');
    assert.equal(fit.unfit?.roomPct, 2);
    assert.equal(fit.unfit?.after, 1);
    assert.equal(fit.sized, 4);
    assert.equal(fit.unsized, 1);
  });

  it('keeps the sums in priority order when a lower priority ranks first', () => {
    const fit = weekFit(rankedRows(testRanking({ classes: { T1: 'Roadmap' } }), { id: 'T1', priority: 2, size: 1 }, { id: 'T2', priority: 1, size: 1 }), week, 5);
    assert.deepEqual([...fit.fits], [[1, 1], [2, 1]]);
  });

  it('leaves out verifying, finished and other weeks, as their spend is already used or not this week', () => {
    const fit = weekFit(
      rows(
        { id: 'T1', size: 50, status: 'verifying' },
        { id: 'T2', size: 50, status: 'done' },
        { id: 'T3', size: 50, status: 'dropped' },
        { id: 'T4', size: 50, week: '2030-01-14' },
        { id: 'T5', size: 2, status: 'waiting' },
      ),
      week,
      5,
    );
    assert.deepEqual([...fit.fits], [[2, 2]]);
    assert.equal(fit.unfit, undefined);
    assert.equal(fit.sized, 1);
  });

  it('sums nothing without a reading of the week', () => {
    const fit = weekFit(rows({ id: 'T1', size: 1 }), week, undefined);
    assert.equal(fit.fits.size, 0);
    assert.equal(fit.unfit, undefined);
  });

  it('orders a roll-up over teams by plan order and keeps each row\'s team', () => {
    const fit = weekFit(
      [
        { task: testTask({ id: 'T2', week, size: 3 }), tree: treeOf([], testRanking()), team: 'beta' },
        { task: testTask({ id: 'T7', week, size: 3 }), tree: treeOf([], testRanking({ classes: { T7: 'Roadmap' } })), team: 'pipeline' },
      ],
      week,
      4,
    );
    assert.equal(fit.unfit?.row.team, 'beta');
  });

  it('orders on the effective due, so work a dated task needs comes first', () => {
    const fit = weekFit(rows({ id: 'T1', size: 3, due: '2030-01-12' }, { id: 'T2', size: 3 }, { id: 'T3', owner: 'beta', due: '2030-01-09', after: ['T2'] }), week, 4);
    assert.equal(fit.unfit?.row.task.id, 'T1', 'T2 is due 01-09 by T3, so it fits first');
  });

  it('leaves a parked task out of the sums, as the plan does', () => {
    const quiet = { workClass: 'Improvements', updatedAt: '2029-12-01T10:00:00.000Z' };
    const fit = weekFit(rankedRows(testRanking(), { id: 'T1', size: 3, ...quiet }, { id: 'T2', ...quiet }, { id: 'T3', size: 1 }), week, 2);
    assert.deepEqual([fit.sized, fit.unsized, fit.unfit], [1, 0, undefined]);
  });
});

describe('fitLines', () => {
  it('prints what fits, the first task past the line with how many follow, and the unsized count', () => {
    const fit = weekFit(rows({ id: 'T1', priority: 1, size: 12 }, { id: 'T2', size: 8.5 }, { id: 'T3', size: 20 }, { id: 'T4', size: 25 }, { id: 'T5' }), week, 31);
    assert.deepEqual(fitLines(fit), [
      'fits: p1 12% · p2 8.5% (left 31% of the week)',
      'does not fit: T3 p2 alpha 20% | Add a health check, +1 after it',
      '1 to do without a size',
    ]);
  });

  it('names the team of a roll-up row', () => {
    const fit = weekFit([{ task: testTask({ id: 'T3', week, size: 5 }), tree: treeOf(), team: 'beta' }], week, 1);
    assert.deepEqual(fitLines(fit), ['fits: none (left 1% of the week)', 'does not fit: beta/T3 p2 alpha 5% | Add a health check']);
  });

  it('says the fit is unknown without a reading, and prints only the unsized count when nothing is sized', () => {
    assert.deepEqual(fitLines(weekFit(rows({ id: 'T1', size: 1 }, { id: 'T2' }), week, undefined)), [
      'fits: unknown (no status-line reading of the week yet)',
      '1 to do without a size',
    ]);
    assert.deepEqual(fitLines(weekFit(rows({ id: 'T1' }, { id: 'T2' }), week, 50)), ['2 to do without a size']);
    assert.deepEqual(fitLines(weekFit([], week, 50)), []);
  });
});

describe('overLimitFlag', () => {
  it('flags the first task past the line with the room left and how many follow', () => {
    const flag = overLimitFlag(weekFit(rows({ id: 'T1', size: 3 }, { id: 'T2', size: 4 }, { id: 'T3', size: 5 }), week, 5));
    assert.equal(flag?.kind, 'OVER-LIMIT');
    assert.equal(flag?.task.id, 'T2');
    assert.equal(flag?.detail, 'size 4%, 2% of the week left after the tasks before it (left 5%), +1 after it');
  });

  it('raises nothing when everything fits or the week is unread', () => {
    assert.equal(overLimitFlag(weekFit(rows({ id: 'T1', size: 3 }), week, 5)), undefined);
    assert.equal(overLimitFlag(weekFit(rows({ id: 'T1', size: 3 }), week, undefined)), undefined);
  });
});
