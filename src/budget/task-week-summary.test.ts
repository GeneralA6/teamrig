import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fieldPaths } from '../testing/field-paths.ts';
import { formatTasksWeek, parseTasksWeek, TASKS_WEEK_FORMAT, type TasksWeekSummary } from './task-week-summary.ts';

const SUMMARY: TasksWeekSummary = {
  at: Date.parse('2030-01-08T10:00:00Z'),
  spentPct: { T10: 0.0001, T7: 1.25, T8: 12 },
};

/** The summary's file as a plain object, to break one field of. */
function stored(): Record<string, unknown> {
  return { v: TASKS_WEEK_FORMAT, at: SUMMARY.at, spentPct: { ...SUMMARY.spentPct } };
}

describe("the tasks' week summary", () => {
  it('reads back what it wrote, the tasks in the order written', () => {
    const text = formatTasksWeek(SUMMARY);
    assert.equal(text, JSON.stringify(stored()));
    assert.deepEqual(parseTasksWeek(text), SUMMARY);
    assert.deepEqual(Object.keys(parseTasksWeek(text)?.spentPct ?? {}), ['T10', 'T7', 'T8']);
  });

  it('reads a team with no spend on any task', () => {
    const empty = { ...SUMMARY, spentPct: {} };
    assert.deepEqual(parseTasksWeek(formatTasksWeek(empty)), empty);
  });

  it('writes the pinned fields of its format: a field added to the file raises TASKS_WEEK_FORMAT', () => {
    const written: Readonly<Record<number, readonly string[]>> = { 1: ['at', 'spentPct.*', 'v'] };
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

  it('reads nothing when a field is missing or of the wrong kind', () => {
    for (const field of ['at', 'spentPct']) {
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
});
