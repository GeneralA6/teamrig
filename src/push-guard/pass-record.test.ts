import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { parsePassRecord, passRecordPath, readPassRecord } from './pass-record.ts';

const TREE = 'a'.repeat(40);
const OTHER_TREE = 'd'.repeat(40);
const COMMIT = 'b'.repeat(40);
const ROOT = resolve('work', 'repo');
const FIELDS = { tree: TREE, commit: COMMIT, checks: ['lint', 'test'], passedAt: '2026-10-15T10:00:00.000Z', node: 'v22.0.0' };

describe('parsePassRecord', () => {
  it('reads the record of the tree it proves', () => {
    assert.deepEqual(parsePassRecord(JSON.stringify(FIELDS), TREE), FIELDS);
  });

  it('ignores a missing, broken or foreign record, and one with a field of the wrong type', () => {
    for (const text of [
      undefined,
      '{',
      '[]',
      'null',
      JSON.stringify({ ...FIELDS, tree: OTHER_TREE }),
      JSON.stringify({ ...FIELDS, commit: 1 }),
      JSON.stringify({ ...FIELDS, passedAt: null }),
      JSON.stringify({ ...FIELDS, node: undefined }),
      JSON.stringify({ ...FIELDS, checks: 'lint' }),
      JSON.stringify({ ...FIELDS, checks: ['lint', 2] }),
    ]) {
      assert.equal(parsePassRecord(text, TREE), undefined, String(text));
    }
  });
});

describe('passRecordPath', () => {
  it('puts a relative git common dir under the repo root', () => {
    assert.equal(passRecordPath(ROOT, '.git', TREE), join(ROOT, '.git', 'local-ci', `${TREE}.json`));
  });

  it('keeps an absolute git common dir, as a worktree reports it', () => {
    const common = resolve('elsewhere', '.git');
    assert.equal(passRecordPath(ROOT, common, TREE), join(common, 'local-ci', `${TREE}.json`));
  });
});

describe('readPassRecord', () => {
  it('reads the record of the tree from its file in the git common dir', async () => {
    const files = new MemoryFiles({ [passRecordPath(ROOT, '.git', TREE)]: JSON.stringify(FIELDS) });
    assert.deepEqual(await readPassRecord(files, ROOT, '.git', TREE), FIELDS);
  });

  it('finds none for a tree with no file, or a file that proves another tree', async () => {
    const files = new MemoryFiles({ [passRecordPath(ROOT, '.git', OTHER_TREE)]: JSON.stringify(FIELDS) });
    assert.equal(await readPassRecord(files, ROOT, '.git', TREE), undefined);
    assert.equal(await readPassRecord(files, ROOT, '.git', OTHER_TREE), undefined);
  });
});
