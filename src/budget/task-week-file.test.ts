import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import { EMPTY_USAGE, newCursor, type UsageState } from './store.ts';
import { keepTasksWeek, tasksWeekOf, type TasksWeekInput } from './task-week-file.ts';
import { formatTasksWeek, parseTasksWeek, TASKS_WEEK_FORMAT } from './task-week-summary.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const DAY = '2030-01-08';
const PATH = '/kit/teams/app/state/usage/tasks.week.json';

/** The app team at 10M W per percent: two sessions on T7, one of them on T8 too, half of a turn still open. */
function input(extra: Partial<TasksWeekInput> = {}): TasksWeekInput {
  const open: UsageState = {
    ...EMPTY_USAGE,
    byTask: { [DAY]: { T7: 20_000_000 } },
    cursors: { 't0.jsonl': { ...newCursor(0, 0, DAY), turn: { tasks: ['T7', 'T8'], held: { [DAY]: 10_000_000 } } } },
  };
  return { wPerPct: 10_000_000, states: [open, { ...EMPTY_USAGE, byTask: { '2030-01-07': { T7: 5_000_000 } } }], now: NOW, ...extra };
}

describe('tasksWeekOf', () => {
  it("reads each task's W at the team's rate, across the stores, an open turn's share included", () => {
    assert.deepEqual(tasksWeekOf(input()), { at: NOW, spentPct: { T7: 3, T8: 0.5 } });
  });

  it('writes the same text whichever order the stores come in', () => {
    const states = [...input().states];
    const backwards = [...states].reverse();
    const first = tasksWeekOf(input({ states }));
    const second = tasksWeekOf(input({ states: backwards }));
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(formatTasksWeek(first), formatTasksWeek(second));
  });

  it('keeps any spend above 0, however small, and the time down to the minute', () => {
    const states = [{ ...EMPTY_USAGE, byTask: { [DAY]: { T7: 1 } } }];
    assert.deepEqual(tasksWeekOf(input({ states, now: NOW + 59_999 })), { at: NOW, spentPct: { T7: 0.0001 } });
  });

  it('holds no entry for a task with no spend', () => {
    const states = [{ ...EMPTY_USAGE, byTask: { [DAY]: { T7: 0, T8: 10_000_000 } } }];
    assert.deepEqual(tasksWeekOf(input({ states }))?.spentPct, { T8: 1 });
  });

  it('reads nothing while the rate is unknown', () => {
    assert.equal(tasksWeekOf(input({ wPerPct: undefined })), undefined);
    assert.equal(tasksWeekOf(input({ wPerPct: 0 })), undefined);
  });
});

describe('keepTasksWeek', () => {
  const summary = { at: NOW, spentPct: { T7: 1 } };

  it('writes the summary, and again only when it changes', async () => {
    const files = new MemoryFiles();
    assert.equal(await keepTasksWeek(files, PATH, summary), true);
    assert.deepEqual(parseTasksWeek((await files.read(PATH)) ?? ''), summary);
    assert.equal(await keepTasksWeek(files, PATH, summary), false, 'the same summary is not written again');
    const moved = { ...summary, spentPct: { T7: 2 } };
    assert.equal(await keepTasksWeek(files, PATH, moved), true);
    assert.equal(await files.read(PATH), formatTasksWeek(moved));
  });

  it('leaves a summary a newer teamrig wrote, past TASKS_WEEK_FORMAT, as it is, without failing', async () => {
    const files = new MemoryFiles();
    const newer = JSON.stringify({ v: TASKS_WEEK_FORMAT + 1, spentPct: {} });
    await files.write(PATH, newer);
    assert.equal(await keepTasksWeek(files, PATH, summary), false);
    assert.equal(await files.read(PATH), newer);
  });
});
