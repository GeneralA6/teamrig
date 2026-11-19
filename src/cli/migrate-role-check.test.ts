import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { migrateRowsFileOf } from './migrate-role-check.ts';

const PATHS = { kitHome: join('/', 'kit'), team: 'app' };
const TASKS = join('/', 'kit', 'teams', 'app', 'tasks');

describe('migrateRowsFileOf: a rows file in one task folder of the team (T4606)', () => {
  it('gives the resolved path of a file in a task folder, or deeper in it, forward slashes too', () => {
    const rows = join(TASKS, 'T4', 'rows.jsonl');
    assert.equal(migrateRowsFileOf(PATHS, rows), resolve(rows));
    assert.equal(migrateRowsFileOf(PATHS, join(TASKS, 'T4', 'batch', 'rows.jsonl')), resolve(TASKS, 'T4', 'batch', 'rows.jsonl'));
    assert.equal(migrateRowsFileOf(PATHS, rows.replaceAll('\\', '/')), resolve(rows));
  });

  it('gives nothing for the tasks folder, a task folder itself, a folder no task id names, another team or a ../ escape', () => {
    for (const file of [
      TASKS,
      join(TASKS, 'rows.jsonl'),
      join(TASKS, 'T4'),
      join(TASKS, 'T0', 'rows.jsonl'),
      join(TASKS, 'notes', 'rows.jsonl'),
      join(TASKS, 't4', 'rows.jsonl'),
      join('/', 'kit', 'teams', 'other', 'tasks', 'T4', 'rows.jsonl'),
      `${join(TASKS, 'T4')}/../../../state/rows.jsonl`,
      join('/', 'elsewhere', 'rows.jsonl'),
    ]) {
      assert.equal(migrateRowsFileOf(PATHS, file), undefined, file);
    }
  });
});
