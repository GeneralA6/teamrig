import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fieldPaths } from '../testing/field-paths.ts';
import { formatTasksWeek, parseTasksWeek, TASKS_WEEK_FORMAT, type TasksWeekSummary } from './task-week-summary.ts';

const SUMMARY: TasksWeekSummary = {
  at: Date.parse('2030-01-08T10:00:00Z'),
  spentPct: { T10: 0.0001, T7: 1.25, T8: 12 },
  likeMedians: [
    { workClass: 'Maintenance', type: null, pct: 0.42 },
    { workClass: 'Maintenance', type: 'bug', pct: 0.0003 },
    { workClass: 'Roadmap', type: 'task', pct: 2.5 },
  ],
};

/** The summary's file as a plain object, to break one field of. */
function stored(): Record<string, unknown> {
  return { v: TASKS_WEEK_FORMAT, at: SUMMARY.at, spentPct: { ...SUMMARY.spentPct }, likeMedians: SUMMARY.likeMedians.map((median) => ({ ...median })) };
}

describe("the tasks' week summary", () => {
  it('reads back what it wrote, the tasks and the medians in the order written', () => {
    const text = formatTasksWeek(SUMMARY);
    assert.equal(text, JSON.stringify(stored()));
    assert.deepEqual(parseTasksWeek(text), SUMMARY);
    assert.deepEqual(Object.keys(parseTasksWeek(text)?.spentPct ?? {}), ['T10', 'T7', 'T8']);
  });

  it('reads a team with no spend on any task and no task done inside the like window', () => {
    const empty = { ...SUMMARY, spentPct: {}, likeMedians: [] };
    assert.deepEqual(parseTasksWeek(formatTasksWeek(empty)), empty);
  });

  it('writes the pinned fields of its format: a field added to the file raises TASKS_WEEK_FORMAT', () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      1: ['at', 'spentPct.*', 'v'],
      2: ['at', 'likeMedians[].pct', 'likeMedians[].type', 'likeMedians[].workClass', 'spentPct.*', 'v'],
    };
    assert.deepEqual(fieldPaths(JSON.parse(formatTasksWeek(SUMMARY)), new Set(['spentPct'])), written[TASKS_WEEK_FORMAT]);
  });

  it('reads nothing from a damaged or torn file', () => {
    assert.equal(parseTasksWeek(''), undefined);
    assert.equal(parseTasksWeek(formatTasksWeek(SUMMARY).slice(0, 30)), undefined);
    assert.equal(parseTasksWeek('[1, 2]'), undefined);
  });

  it('reads nothing from a format it does not know, an older unversioned one or a newer one', () => {
    assert.equal(parseTasksWeek(JSON.stringify({ ...stored(), v: undefined })), undefined);
    assert.equal(parseTasksWeek(JSON.stringify({ ...stored(), v: TASKS_WEEK_FORMAT + 1 })), undefined);
  });

  it('reads nothing from the first format, which has no medians, so a reader never sizes a task without them', () => {
    assert.equal(parseTasksWeek(JSON.stringify({ v: 1, at: SUMMARY.at, spentPct: SUMMARY.spentPct })), undefined);
    assert.equal(parseTasksWeek(JSON.stringify({ ...stored(), v: 1 })), undefined);
  });

  it('reads nothing when a field is missing or of the wrong kind', () => {
    for (const field of ['at', 'spentPct', 'likeMedians']) {
      assert.equal(parseTasksWeek(JSON.stringify({ ...stored(), [field]: undefined })), undefined, `${field} missing`);
      assert.equal(parseTasksWeek(JSON.stringify({ ...stored(), [field]: '15' })), undefined, `${field} a string`);
    }
  });

  it("reads nothing when a task's entry is damaged, rather than a team short of that task's spend", () => {
    const broken: readonly unknown[] = ['5', -1, null, { pct: 5 }];
    for (const entry of broken) {
      const text = JSON.stringify({ ...stored(), spentPct: { ...SUMMARY.spentPct, T7: entry } });
      assert.equal(parseTasksWeek(text), undefined, JSON.stringify(entry));
    }
  });

  it('reads nothing when a median is damaged, rather than a kind of task sized on the default', () => {
    const good = { workClass: 'Roadmap', type: 'task', pct: 2.5 };
    const broken: readonly unknown[] = [
      null,
      '2.5',
      { ...good, workClass: '' },
      { ...good, workClass: 7 },
      { ...good, workClass: undefined },
      { ...good, type: 7 },
      { ...good, type: undefined },
      { ...good, pct: 0 },
      { ...good, pct: -1 },
      { ...good, pct: '2.5' },
      { ...good, pct: undefined },
    ];
    for (const median of broken) {
      const text = JSON.stringify({ ...stored(), likeMedians: [...SUMMARY.likeMedians, median] });
      assert.equal(parseTasksWeek(text), undefined, JSON.stringify(median));
    }
  });

  it('leaves out the median of a type a newer teamrig writes, as this one reads its tasks as tasks', () => {
    const text = JSON.stringify({ ...stored(), likeMedians: [...SUMMARY.likeMedians, { workClass: 'Roadmap', type: 'epic', pct: 9 }] });
    assert.deepEqual(parseTasksWeek(text), SUMMARY);
  });
});
