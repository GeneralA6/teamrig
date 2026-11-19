import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { testTask } from '../testing/task.ts';
import { blockerHold } from './blocker-hold.ts';
import type { Task } from './fold.ts';
import { BLOCKER_PRIORITY_ID, type TaskStatus } from './model.ts';
import { waitContext } from './waits.ts';

const NOW = new Date(Date.UTC(2030, 0, 7, 9));

const BLOCKER = testTask({ id: 'T1', priority: BLOCKER_PRIORITY_ID });
const OTHER = testTask({ id: 'T2', priority: 0 });

/** What the hold says of moving `task` to `status`, with `others` on the register beside it. */
function holdOf(task: Task, others: readonly Task[], status: TaskStatus = 'in-progress'): string | undefined {
  const tasks = [task, ...others];
  const context = waitContext(new Map(tasks.map((held) => [held.id, held])), NOW, TimeZone.UTC);
  return blockerHold(task, status, tasks, context);
}

describe('blockerHold (T4329)', () => {
  it("refuses a start of any other task, p0 included, while its owner holds an open or started blocker", () => {
    const expected = 'alpha holds the blocker T1: drop everything and fix it first; start T2 once it is done or waits on an answer';
    assert.equal(holdOf(OTHER, [BLOCKER]), expected);
    assert.equal(holdOf(OTHER, [{ ...BLOCKER, status: 'in-progress' }]), expected);
  });

  it('lets the blocker itself start, and a second blocker beside it', () => {
    assert.equal(holdOf(BLOCKER, [OTHER]), undefined);
    assert.equal(holdOf({ ...BLOCKER, id: 'T3' }, [BLOCKER]), undefined);
  });

  it("holds nothing once the blocker is finished or waits on an answer, nor for another owner's blocker", () => {
    for (const status of ['done', 'dropped', 'waiting', 'verifying'] as const) {
      assert.equal(holdOf(OTHER, [{ ...BLOCKER, status }]), undefined, status);
    }
    assert.equal(holdOf(OTHER, [{ ...BLOCKER, owner: 'bravo' }]), undefined);
  });

  it('holds no move that opens no new work: a reopen, a wait, a task already in progress', () => {
    assert.equal(holdOf({ ...OTHER, status: 'verifying' }, [BLOCKER]), undefined);
    assert.equal(holdOf({ ...OTHER, status: 'in-progress' }, [BLOCKER]), undefined);
    assert.equal(holdOf(OTHER, [BLOCKER], 'waiting'), undefined);
  });
});
