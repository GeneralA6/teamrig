import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { MIGRATE_ROWS_MAX_BYTES, migrateRowsFileOf, migrateWeightOf } from './migrate-role-check.ts';

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

describe('migrateWeightOf: what a role migrate weighs toward the daily cap (C6, T4606)', () => {
  const ROWS = join(TASKS, 'T4', 'rows.jsonl');
  const issue = (id: string): string => JSON.stringify({ id, decision: 'issue', repo: 'acme/web', type: 'task', priority: 'p2', title: `Fix ${id.slice(1)}`, body: 'Why.' });
  const local = (id: string): string => JSON.stringify({ id, decision: 'local', reason: 'Names a host.' });

  it('counts the issue rows, never a local row, and weighs a file of local rows alone as one call', async () => {
    const files = new MemoryFiles({ [ROWS]: [issue('T1'), local('T2'), issue('T3'), '', issue('T5')].join('\n') });
    assert.equal(await migrateWeightOf(files, ROWS, []), 3);
    await files.write(ROWS, local('T2'));
    assert.equal(await migrateWeightOf(files, ROWS, []), 1);
  });

  it('gives nothing for a missing file, a row the run refuses, or a file past the read limit', async () => {
    const files = new MemoryFiles({ [ROWS]: [issue('T1'), 'not json'].join('\n') });
    assert.equal(await migrateWeightOf(files, join(TASKS, 'T4', 'other.jsonl'), []), undefined, 'missing');
    assert.equal(await migrateWeightOf(files, ROWS, []), undefined, 'a bad row');
    await files.write(ROWS, JSON.stringify({ id: 'T1', decision: 'issue', repo: 'acme/web', type: 'task', priority: 'p2', title: 'Fix it', body: 'Ask sesame.' }));
    assert.equal(await migrateWeightOf(files, ROWS, ['sesame']), undefined, "a team secret pattern's text");
    await files.write(ROWS, `${issue('T1')}\n${' '.repeat(MIGRATE_ROWS_MAX_BYTES)}`);
    assert.equal(await migrateWeightOf(files, ROWS, []), undefined, 'past the limit');
  });
});
