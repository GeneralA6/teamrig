import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import { fitLines, leftOfWeek, overLimitFlag, weekFit, type FitRow } from './fit.ts';

const week = '2030-01-07';

function rows(...tasks: Parameters<typeof testTask>[0][]): FitRow[] {
  return tasks.map((fields) => ({ task: testTask({ week, ...fields }) }));
}

describe('leftOfWeek', () => {
  it('is the pace target less the week used, never below 0', () => {
    assert.equal(leftOfWeek(99.5, 81), 18.5);
    assert.equal(leftOfWeek(99.5, 100), 0);
  });
});

describe('weekFit', () => {
  it('sums the sized to-do tasks per priority in plan order and names the first past the line', () => {
    const fit = weekFit(
      rows(
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
        { task: testTask({ id: 'T2', week, priority: 2, size: 3 }), team: 'beta' },
        { task: testTask({ id: 'T7', week, priority: 1, size: 3 }), team: 'pipeline' },
      ],
      week,
      4,
    );
    assert.equal(fit.unfit?.row.team, 'beta');
  });
});

describe('fitLines', () => {
  it('prints what fits, the first task past the line with how many follow, and the unsized count', () => {
    const fit = weekFit(rows({ id: 'T1', priority: 1, size: 12 }, { id: 'T2', size: 8.5 }, { id: 'T3', size: 20 }, { id: 'T4', size: 1 }, { id: 'T5' }), week, 31);
    assert.deepEqual(fitLines(fit), [
      'fits: p1 12% · p2 8.5% (left 31% of the week)',
      'does not fit: T3 p2 alpha 20% | Add a health check, +1 after it',
      '1 to do without a size',
    ]);
  });

  it('names the team of a roll-up row', () => {
    const fit = weekFit([{ task: testTask({ id: 'T3', week, size: 5 }), team: 'beta' }], week, 1);
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
    const flag = overLimitFlag(weekFit(rows({ id: 'T1', size: 3 }, { id: 'T2', size: 4 }, { id: 'T3', size: 1 }), week, 5));
    assert.equal(flag?.kind, 'OVER-LIMIT');
    assert.equal(flag?.task.id, 'T2');
    assert.equal(flag?.detail, 'size 4%, 2% of the week left after the tasks before it (left 5%), +1 after it');
  });

  it('raises nothing when everything fits or the week is unread', () => {
    assert.equal(overLimitFlag(weekFit(rows({ id: 'T1', size: 3 }), week, 5)), undefined);
    assert.equal(overLimitFlag(weekFit(rows({ id: 'T1', size: 3 }), week, undefined)), undefined);
  });
});
