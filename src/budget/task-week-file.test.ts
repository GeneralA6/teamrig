import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { likeSizing, storedSizing, type LikeTask } from '../register/ranking.ts';
import type { TreeTask } from '../register/tree.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { EMPTY_USAGE, newCursor, type UsageState } from './store.ts';
import { spentSince, taskUseReader } from './task-use.ts';
import { keepTasksWeek, tasksWeekOf, type TasksWeekInput } from './task-week-file.ts';
import { formatTasksWeek, parseTasksWeek, TASKS_WEEK_FORMAT } from './task-week-summary.ts';

const NOW = Date.parse('2030-01-08T10:00:00Z');
const DAY = '2030-01-08';
const EARLIER = '2030-01-07';
const PATH ='/kit/teams/app/state/usage/tasks.week.json';
const FOCUS = { defaultClass: 'Maintenance' };
/** Inside the like window at NOW. */
const LATELY = '2030-01-08T09:00:00.000Z';

/** A task done lately, of `workClass` and `type`. */
function doneTask(id: string, workClass: string | null, type: LikeTask['type']): LikeTask {
  return { id, status: 'done', statusAt: LATELY, workClass, type };
}

/** T7 a Roadmap bug and T8 of no class or type, both done lately. */
const LIKE_TASKS: readonly LikeTask[] = [doneTask('T7', 'Roadmap', 'bug'), doneTask('T8', null, null)];

/** One session's store holding `byTask`, by the id a test's team reads it under. */
function alone(byTask: UsageState['byTask']): ReadonlyMap<string, UsageState> {
  return new Map([['alpha', { ...EMPTY_USAGE, byTask }]]);
}

/** The app team at 10M W per percent: two sessions on T7, one of them on T8 too, half of a turn still open. */
function input(extra: Partial<TasksWeekInput> = {}): TasksWeekInput {
  const open: UsageState = {
    ...EMPTY_USAGE,
    byTask: { [DAY]: { T7: 20_000_000 } },
    cursors: { 't0.jsonl': { ...newCursor(0, 0, DAY), turn: { tasks: ['T7', 'T8'], held: { [DAY]: 10_000_000 } } } },
  };
  const bySession = new Map([['alpha', open], ['bravo', { ...EMPTY_USAGE, byTask: { [EARLIER]: { T7: 5_000_000 } } }]]);
  return { wPerPct: 10_000_000, bySession, bases: new Map(), likeTasks: [], focus: FOCUS, now: NOW, ...extra };
}

describe('tasksWeekOf', () => {
  it("reads each task's W at the team's rate, across the stores, an open turn's share included", () => {
    assert.deepEqual(tasksWeekOf(input()), { at: NOW, spentPct: { T7: 3, T8: 0.5 }, likeMedians: [] });
  });

  it('holds the median spend of each kind of task done lately, a task of no class under the default one, by class', () => {
    assert.deepEqual(tasksWeekOf(input({ likeTasks: LIKE_TASKS }))?.likeMedians, [
      { workClass: 'Maintenance', type: null, pct: 0.5 },
      { workClass: 'Roadmap', type: 'bug', pct: 3 },
    ]);
  });

  it("takes a sized task's whole cost into its kind's median, as teamrig list does, while its own entry counts from its base", () => {
    const summary = tasksWeekOf(input({ likeTasks: LIKE_TASKS, bases: new Map([['T7', { day: EARLIER, w: 5_000_000 }]]) }));
    assert.deepEqual(summary?.spentPct, { T7: 2.5, T8: 0.5 });
    assert.deepEqual(summary?.likeMedians.find((median) => median.workClass === 'Roadmap'), { workClass: 'Roadmap', type: 'bug', pct: 3 });
  });

  it('rounds a median up, so a kind of task that spent anything never reads 0', () => {
    const summary = tasksWeekOf(input({ bySession: alone({ [DAY]: { T7: 1 } }), likeTasks: LIKE_TASKS }));
    assert.deepEqual(summary?.likeMedians, [{ workClass: 'Roadmap', type: 'bug', pct: 0.0001 }]);
  });

  it('holds no median for a kind whose tasks were done before the window, a kept reading of them included', () => {
    const old = LIKE_TASKS.map((task) => ({ ...task, statusAt: '2029-12-01T09:00:00.000Z' }));
    assert.deepEqual(tasksWeekOf(input({ likeTasks: old }))?.likeMedians, []);
  });

  it('sizes a task, once the file is read back, as teamrig list sizes it from the meter', () => {
    const { bySession } = input();
    const bases = new Map([['T7', { day: EARLIER, w: 5_000_000 }]]);
    const summary = tasksWeekOf(input({ likeTasks: LIKE_TASKS, bases }));
    assert.ok(summary !== undefined);
    const read = parseTasksWeek(formatTasksWeek(summary));
    assert.ok(read !== undefined);
    const useOf = taskUseReader(bySession);
    const list = likeSizing(LIKE_TASKS, FOCUS, (task) => spentSince(useOf(task.id), task.sizeBase) / 10_000_000, NOW);
    const file = storedSizing(read, FOCUS);
    const rows: readonly TreeTask[] = [
      { id: 'T7', status: 'done', owner: 'alpha', priority: 1, due: null, after: [], waits: [], workClass: 'Roadmap', type: 'bug', sizeBase: { day: EARLIER, w: 5_000_000 } },
      { id: 'T8', status: 'done', owner: 'alpha', priority: 1, due: null, after: [], waits: [] },
      { id: 'T9', status: 'open', owner: 'alpha', priority: 1, due: null, after: [], waits: [], workClass: 'Roadmap', type: 'bug' },
      { id: 'T10', status: 'open', owner: 'alpha', priority: 1, due: null, after: [], waits: [], workClass: 'Roadmap', type: 'task', size: 2 },
    ];
    for (const row of rows) {
      assert.deepEqual(file(row), list(row), row.id);
    }
  });

  it('writes the same text whichever order the stores come in', () => {
    const bySession = input().bySession;
    const first = tasksWeekOf(input({ bySession }));
    const second = tasksWeekOf(input({ bySession: new Map([...bySession].reverse()) }));
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(formatTasksWeek(first), formatTasksWeek(second));
  });

  it('keeps any spend above 0, however small, and the time down to the minute', () => {
    assert.deepEqual(tasksWeekOf(input({ bySession: alone({ [DAY]: { T7: 1 } }), now: NOW + 59_999 })), { at: NOW, spentPct: { T7: 0.0001 }, likeMedians: [] });
  });

  it('holds no entry for a task with no spend', () => {
    assert.deepEqual(tasksWeekOf(input({ bySession: alone({ [DAY]: { T7: 0, T8: 10_000_000 } }) }))?.spentPct, { T8: 1 });
  });

  it("counts a sized task from its base as the ranking does: the base's day past its W, the days after in full, the days before none (T2141)", () => {
    const bySession = alone({ '2030-01-06': { T7: 40_000_000 }, [EARLIER]: { T7: 25_000_000 }, [DAY]: { T7: 10_000_000 } });
    const bases = new Map([['T7', { day: EARLIER, w: 20_000_000 }]]);
    assert.deepEqual(tasksWeekOf(input({ bySession, bases }))?.spentPct, { T7: 1.5 });
  });

  it("counts a sized task's base across the stores, an open turn's share and the other sessions' days included (T2141)", () => {
    assert.deepEqual(tasksWeekOf(input({ bases: new Map([['T7', { day: EARLIER, w: 5_000_000 }]]) }))?.spentPct, { T7: 2.5, T8: 0.5 });
  });

  it('holds no entry for a sized task with nothing since its base, and leaves the unsized tasks whole (T2141)', () => {
    const bySession = alone({ [DAY]: { T7: 10_000_000, T8: 10_000_000 } });
    const bases = new Map([['T7', { day: DAY, w: 10_000_000 }]]);
    assert.deepEqual(tasksWeekOf(input({ bySession, bases }))?.spentPct, { T8: 1 });
  });

  it('counts only the days after a base whose day the meter no longer keeps (T2141)', () => {
    const bases = new Map([['T7', { day: '2029-12-01', w: 90_000_000 }]]);
    assert.deepEqual(tasksWeekOf(input({ bySession: alone({ [DAY]: { T7: 10_000_000 } }), bases }))?.spentPct, { T7: 1 });
  });

  it('reads nothing while the rate is unknown', () => {
    assert.equal(tasksWeekOf(input({ wPerPct: undefined })), undefined);
    assert.equal(tasksWeekOf(input({ wPerPct: 0 })), undefined);
  });
});

describe('keepTasksWeek', () => {
  const summary = { at: NOW, spentPct: { T7: 1 }, likeMedians: [{ workClass: 'Roadmap', type: null, pct: 0.5 }] };

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
