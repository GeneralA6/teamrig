import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import type { Task } from './fold.ts';
import { overSizeFlags } from './over-size.ts';

/** What each task spent, in percent of the weekly limit; 0 for a task the map leaves out. */
function spentOf(spent: Record<string, number>): (task: Task) => number {
  return (task) => spent[task.id] ?? 0;
}

function flagsOf(spent: Record<string, number>, multiple = 2, tasks = [testTask({ id: 'T1', size: 0.5 })]): string[] {
  return overSizeFlags(tasks, spentOf(spent), multiple).map((flag) => `${flag.kind} ${flag.task.id} (${flag.detail})`);
}

describe('overSizeFlags', () => {
  it('flags a sized task once it spent more than the multiple of its size', () => {
    assert.deepEqual(flagsOf({ T1: 1.15 }), ['OVER-SIZE T1 (spent 1.15% of the week, 2.3x its size 0.5%)']);
    assert.deepEqual(flagsOf({ T1: 1 }), [], 'exactly the multiple is not past it');
    assert.deepEqual(flagsOf({ T1: 0.8 }, 1.5), ['OVER-SIZE T1 (spent 0.8% of the week, 1.6x its size 0.5%)']);
  });

  it('asks the spend of the task itself, and names spend since a re-size as such (T649)', () => {
    const asked: Task[] = [];
    const task = testTask({ id: 'T1', size: 0.5, sizeBase: { day: '2030-01-07', w: 12_000_000 } });
    const flags = overSizeFlags(
      [task],
      (seen) => {
        asked.push(seen);
        return 1.2;
      },
      2,
    );
    assert.deepEqual(asked, [task]);
    assert.deepEqual(flags.map((flag) => flag.detail), ['spent 1.2% since it was sized, 2.4x its size 0.5%']);
  });

  it('reads every active status and no finished one', () => {
    for (const status of ['open', 'in-progress', 'waiting', 'verifying'] as const) {
      assert.equal(flagsOf({ T1: 2 }, 2, [testTask({ id: 'T1', size: 0.5, status })]).length, 1, status);
    }
    for (const status of ['done', 'dropped'] as const) {
      assert.deepEqual(flagsOf({ T1: 2 }, 2, [testTask({ id: 'T1', size: 0.5, status })]), [], status);
    }
  });

  it('skips an unsized task, a size of 0, and everything at a multiple of 0', () => {
    assert.deepEqual(flagsOf({ T1: 2 }, 2, [testTask({ id: 'T1', size: null })]), []);
    assert.deepEqual(flagsOf({ T1: 2 }, 2, [testTask({ id: 'T1', size: 0 })]), []);
    assert.deepEqual(flagsOf({ T1: 2 }, 0), []);
  });

  it('flags each task over on its own, in the order given', () => {
    const tasks = [testTask({ id: 'T1', size: 0.5 }), testTask({ id: 'T2', size: 1 }), testTask({ id: 'T3', size: 0.2 })];
    assert.deepEqual(
      flagsOf({ T1: 1.2, T2: 1.5, T3: 0.5 }, 2, tasks).map((line) => line.split(' (')[0]),
      ['OVER-SIZE T1', 'OVER-SIZE T3'],
    );
  });
});
