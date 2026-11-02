import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import type { RegisterState } from './fold.ts';
import { parseRefChanges, planLine, planRefChanges, REF_CHANGE_SHAPE, updateLine, type RefChange, type RefJudge } from './ref-changes.ts';

const OLD = 'notes/ops/board.md';
const NEW = 'notes/ops/archive/board.md';

function change(overrides: Partial<RefChange> = {}): RefChange {
  return { team: 'alpha', id: 'T1', oldRef: OLD, newRef: NEW, ...overrides };
}

const STATE: RegisterState = {
  tasks: new Map([
    ['T1', testTask({ id: 'T1', ref: OLD })],
    ['T2', testTask({ id: 'T2', ref: NEW })],
    ['T3', testTask({ id: 'T3', ref: 'notes/ops/elsewhere.md' })],
    ['T4', testTask({ id: 'T4', ref: null })],
  ]),
  orphans: 0,
  nextId: 'T9',
  moved: new Map([['T5', 'bravo']]),
};

const ALLOW: RefJudge = () => undefined;

describe('parseRefChanges', () => {
  it('reads a list of rows, keeping only their four fields', () => {
    const rows = [change(), { ...change({ id: 'T2' }), note: 'extra' }];
    assert.deepEqual(parseRefChanges(rows), { ok: true, value: [change(), change({ id: 'T2' })] });
    assert.deepEqual(parseRefChanges([]), { ok: true, value: [] });
  });

  it('refuses a file that is not a list, naming the shape it wants', () => {
    assert.deepEqual(parseRefChanges({ rows: [change()] }), { ok: false, error: `the file holds no list of ref changes: ${REF_CHANGE_SHAPE}` });
  });

  it('refuses a bad row by its number: a missing field, a blank ref or an id that is not T<n>', () => {
    const bad = [{ team: 'alpha', id: 'T1', oldRef: OLD }, change({ newRef: ' ' }), change({ id: '12' }), change({ team: '' }), 'T1'];
    for (const row of bad) {
      assert.deepEqual(parseRefChanges([change({ id: 'T7' }), row]), { ok: false, error: `row 2 is not a ref change: ${REF_CHANGE_SHAPE}` });
    }
  });

  it('refuses a row that changes nothing and a task that comes twice', () => {
    assert.deepEqual(parseRefChanges([change({ newRef: OLD })]), { ok: false, error: 'row 1 changes nothing: alpha/T1 has the same oldRef and newRef' });
    assert.deepEqual(parseRefChanges([change(), change({ newRef: 'notes/other.md' })]), { ok: false, error: 'row 2 repeats alpha/T1: give each task one row' });
    assert.deepEqual(parseRefChanges([change(), change({ team: 'bravo' })]).ok, true);
  });
});

describe('planRefChanges', () => {
  it('updates a task that still reads the old ref, and leaves one already moved or changed since', () => {
    const rows = planRefChanges([change(), change({ id: 'T2' }), change({ id: 'T3' }), change({ id: 'T4' })], 'alpha', STATE, ALLOW);
    assert.deepEqual(rows, [
      { change: change(), action: 'update' },
      { change: change({ id: 'T2' }), action: 'already-new' },
      { change: change({ id: 'T3' }), action: 'changed-since', refNow: 'notes/ops/elsewhere.md' },
      { change: change({ id: 'T4' }), action: 'changed-since', refNow: null },
    ]);
  });

  it("leaves another team's row, a task that moved and an id the working set lacks, without judging them", () => {
    const judged: string[] = [];
    const judge: RefJudge = (task) => {
      judged.push(task.id);
      return undefined;
    };
    const rows = planRefChanges([change({ team: 'bravo' }), change({ id: 'T5' }), change({ id: 'T8' })], 'alpha', STATE, judge);
    assert.deepEqual(rows, [
      { change: change({ team: 'bravo' }), action: 'other-team' },
      { change: change({ id: 'T5' }), action: 'not-found', movedTo: 'bravo' },
      { change: change({ id: 'T8' }), action: 'not-found', movedTo: undefined },
    ]);
    assert.deepEqual(judged, []);
  });

  it("asks the judge only for a row it would write, and leaves it with the judge's reason", () => {
    const asked: Array<[string, string]> = [];
    const judge: RefJudge = (task, row) => {
      asked.push([task.id, row.newRef]);
      return 'only the owner (alpha) or a leader changes ref';
    };
    const rows = planRefChanges([change(), change({ id: 'T2' })], 'alpha', STATE, judge);
    assert.deepEqual(rows, [
      { change: change(), action: 'refused', reason: 'only the owner (alpha) or a leader changes ref' },
      { change: change({ id: 'T2' }), action: 'already-new' },
    ]);
    assert.deepEqual(asked, [['T1', NEW]]);
  });
});

describe('the row lines', () => {
  it('names a write by its verb', () => {
    assert.equal(updateLine('UPDATED', change()), `UPDATED T1: ${OLD} -> ${NEW}`);
  });

  it('names the write a dry run would make, and each row left and why', () => {
    const rows = planRefChanges(
      [change(), change({ id: 'T2' }), change({ id: 'T3' }), change({ id: 'T4' }), change({ team: 'bravo' }), change({ id: 'T5' }), change({ id: 'T8' })],
      'alpha',
      STATE,
      ALLOW,
    );
    assert.deepEqual(rows.map(planLine), [
      `WOULD UPDATE T1: ${OLD} -> ${NEW}`,
      `LEFT T2 (already-new): its ref reads ${NEW}`,
      `LEFT T3 (changed-since): its ref reads notes/ops/elsewhere.md, not ${OLD}`,
      `LEFT T4 (changed-since): its ref reads none, not ${OLD}`,
      'LEFT bravo/T1 (other-team): a session of team bravo applies it',
      'LEFT T5 (not-found): it moved to team bravo, whose sessions apply it',
      'LEFT T8 (not-found): no task T8 in the working set',
    ]);
    assert.equal(planLine({ change: change(), action: 'refused', reason: 'not yours' }), 'LEFT T1 (refused): not yours');
  });
});
