import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatRollup, parseRollup, rollupFileName, type TaskRow, type TeamDayRollup, type UseRow } from './rollup-file.ts';

const ROW: UseRow = {
  session: 'alpha',
  useClass: 'work',
  model: 'model-a',
  effort: null,
  w: 120,
  input: 10,
  cacheWrite: 20,
  cacheRead: 30,
  output: 4,
  turns: 1,
  calls: 2,
  seconds: 60,
};
const TASK: TaskRow = { session: 'alpha', task: 'T1', w: 120, seconds: 60 };
const NO_TASK: TaskRow = { session: 'alpha', task: null, w: 0, seconds: 0 };
const ROLLUP: TeamDayRollup = { day: '2026-11-02', team: 'alpha-team', rows: [ROW], tasks: [TASK, NO_TASK] };

/** The rollup's file with `fields` over its top level, as a damaged or older file would hold them. */
function fileWith(fields: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ v: 1, day: ROLLUP.day, team: ROLLUP.team, rows: ROLLUP.rows, tasks: ROLLUP.tasks, ...fields });
}

describe('rollup file', () => {
  it('reads back what it wrote', () => {
    assert.deepEqual(parseRollup(formatRollup(ROLLUP)), ROLLUP);
  });

  it('gives the same text for the same rows, which a rewrite of a day rests on', () => {
    const first = formatRollup(ROLLUP);
    const parsed = parseRollup(first);
    assert.ok(parsed !== undefined);
    assert.equal(formatRollup(parsed), first);
  });

  it('names a file by its day', () => {
    assert.equal(rollupFileName('2026-11-02'), '2026-11-02.json');
  });

  it('refuses a file it cannot read', () => {
    assert.equal(parseRollup('not json'), undefined);
    assert.equal(parseRollup(fileWith({ v: 2 })), undefined, 'a newer format');
    assert.equal(parseRollup(fileWith({ day: 'monday' })), undefined, 'no day');
    assert.equal(parseRollup(fileWith({ team: 7 })), undefined, 'no team');
    assert.equal(parseRollup(fileWith({ rows: 'many' })), undefined, 'rows that are no list');
    assert.equal(parseRollup(fileWith({ tasks: undefined })), undefined, 'no tasks');
  });

  it('refuses a whole file for one damaged row, as half a day would read as a low day', () => {
    assert.equal(parseRollup(fileWith({ rows: [ROW, 'torn'] })), undefined);
    assert.equal(parseRollup(fileWith({ rows: [{ ...ROW, useClass: 'gaming' }] })), undefined, 'a class it does not know');
    assert.equal(parseRollup(fileWith({ rows: [{ ...ROW, w: '120' }] })), undefined, 'a W that is no number');
    assert.equal(parseRollup(fileWith({ rows: [{ ...ROW, model: 7 }] })), undefined, 'a model that is neither text nor null');
    assert.equal(parseRollup(fileWith({ tasks: [{ ...TASK, seconds: undefined }] })), undefined, 'a task row short of a field');
    assert.equal(parseRollup(fileWith({ tasks: ['torn'] })), undefined);
  });
});
