import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MS_PER_DAY } from '../core/time.ts';
import { EMPTY_USAGE, newCursor, pruneUsage, type UsageState } from './store.ts';
import { attributedW, taskDaysOf, taskUseOf, taskWOf } from './task-use.ts';
import type { OpenTurn } from './tasks.ts';

const DAY = '2030-01-08';
const NEXT_DAY = '2030-01-09';

/** A session's usage with W per day per task and the open turns its transcripts ended in. */
function usage(byTask: UsageState['byTask'], turns: readonly OpenTurn[] = []): UsageState {
  const cursors = Object.fromEntries(turns.map((turn, index) => [`t${index}.jsonl`, { ...newCursor(0, 0, DAY), turn }]));
  return { ...EMPTY_USAGE, byTask, cursors };
}

describe('taskUseOf', () => {
  it('sums stored W and the open turns share of each session, the most first', () => {
    const bySession = new Map<string, UsageState>([
      ['alpha', usage({ [DAY]: { T7: 1_000_000 } })],
      ['beta', usage({ [NEXT_DAY]: { T7: 500_000 }, [DAY]: { T7: 250_000, T8: 9_000_000 } }, [{ tasks: ['T7', 'T8'], held: { [NEXT_DAY]: 4_000_000 } }])],
      ['gamma', usage({ [DAY]: { T8: 2_000_000 } })],
    ]);

    assert.deepEqual(taskUseOf(bySession, 'T7'), {
      task: 'T7',
      sessions: [
        { session: 'beta', byDay: { [DAY]: 250_000, [NEXT_DAY]: 2_500_000 }, w: 2_750_000 },
        { session: 'alpha', byDay: { [DAY]: 1_000_000 }, w: 1_000_000 },
      ],
      w: 3_750_000,
    });
  });

  it('leaves out an open turn that did not name the task', () => {
    const bySession = new Map<string, UsageState>([['alpha', usage({}, [{ tasks: ['T8'], held: { [DAY]: 3_000_000 } }])]]);

    assert.deepEqual(taskUseOf(bySession, 'T7'), { task: 'T7', sessions: [], w: 0 });
  });
});

describe('taskDaysOf', () => {
  it('reads each day of stored task W and splits an open turn equally over the tasks it named', () => {
    const state = usage({ [DAY]: { T7: 1_000_000, T8: 500_000 } }, [
      { tasks: ['T7', 'T9'], held: { [DAY]: 2_000_000, [NEXT_DAY]: 4_000_000 } },
      { tasks: [], held: { [DAY]: 8_000_000 } },
    ]);

    const days = taskDaysOf(state);

    assert.deepEqual(Object.fromEntries(days.get(DAY) ?? []), { T7: 2_000_000, T8: 500_000, T9: 1_000_000 });
    assert.deepEqual(Object.fromEntries(days.get(NEXT_DAY) ?? []), { T7: 2_000_000, T9: 2_000_000 });
  });

  it('holds no day for a session with no task W', () => {
    assert.equal(taskDaysOf(usage({})).size, 0);
  });
});

describe('taskWOf', () => {
  const bySession = new Map<string, UsageState>([
    ['alpha', usage({ [DAY]: { T7: 1_000_000 } })],
    ['beta', usage({ [NEXT_DAY]: { T7: 500_000 }, [DAY]: { T7: 250_000, T8: 9_000_000 } }, [{ tasks: ['T7', 'T8'], held: { [DAY]: 1_000_000, [NEXT_DAY]: 3_000_000 } }])],
    ['gamma', usage({}, [{ tasks: ['T9'], held: { [DAY]: 2_000_000 } }, { tasks: [], held: { [DAY]: 8_000_000 } }])],
  ]);

  it("sums every task's stored W and its share of the open turns that named it, never a turn that named none", () => {
    assert.deepEqual(Object.fromEntries(taskWOf(bySession.values())), { T7: 3_750_000, T8: 11_000_000, T9: 2_000_000 });
  });

  it("reads each task's W as taskUseOf does", () => {
    const all = taskWOf(bySession.values());
    for (const task of ['T7', 'T8', 'T9']) {
      assert.equal(all.get(task), taskUseOf(bySession, task).w, task);
    }
  });

  it('is empty with no stores and with no task W', () => {
    assert.equal(taskWOf([]).size, 0);
    assert.equal(taskWOf([usage({})]).size, 0);
  });
});

describe('attributedW', () => {
  it('counts a day of stored task W and the held W of open turns that named a task', () => {
    const state = usage({ [DAY]: { T7: 1_000_000, T8: 500_000 }, [NEXT_DAY]: { T7: 7_000_000 } }, [
      { tasks: ['T9'], held: { [DAY]: 2_000_000, [NEXT_DAY]: 1_000_000 } },
      { tasks: [], held: { [DAY]: 8_000_000 } },
    ]);

    assert.equal(attributedW(state, DAY), 3_500_000);
  });

  it('is 0 on a day with no task W', () => {
    assert.equal(attributedW(usage({}), DAY), 0);
  });
});

describe('a prune that closes an open turn (T2052)', () => {
  it('reads the same W on a task and a day as before it, so the turn counts once', () => {
    const state = usage({ [DAY]: { T7: 1_000_000 } }, [{ tasks: ['T7', 'T8'], held: { [DAY]: 3_000_000 } }]);
    const pruned = pruneUsage(state, Date.parse(`${DAY}T12:00:00Z`) + 2 * MS_PER_DAY);

    assert.deepEqual(pruned.cursors, {});
    assert.deepEqual(taskUseOf(new Map([['alpha', pruned]]), 'T7'), taskUseOf(new Map([['alpha', state]]), 'T7'));
    assert.equal(attributedW(pruned, DAY), attributedW(state, DAY));
  });
});
