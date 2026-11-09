import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NewerDataError } from '../core/jsonl.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { MERGE_FORMAT, mergeRecordOf, type ApprovedMerge } from './merge-log.ts';
import { formatPendingMerge, PENDING_MERGE_FORMAT, pendingMergePath, readPendingMerge, removePendingMerge, writePendingMerge, type PendingMerge } from './pending-merges.ts';

const PLACES = { pendingMerges: '/team/deploys/pending-merges' };
const PENDING: PendingMerge = { session: 'api', repo: 'app', branch: 'feat/login', head: 'rebased', base: 'base', since: '2030-01-08T10:00:00.000Z', note: 'https://forge/pr/7', merge: undefined };
/** The merges row the self-merge step weighed, every field set and every list filled, so the pin sees each path. */
const ROW: ApprovedMerge = {
  at: '2030-01-08T10:00:00.000Z',
  session: 'api',
  repo: 'app',
  branch: 'feat/login',
  task: 'T7',
  base: 'base',
  head: 'rebased',
  tree: 'tree',
  files: 2,
  lines: 40,
  checks: ['unit', 'lint'],
  review: 'checked',
  route: 'approved',
  missed: ['task', 'tests'],
  approvedBy: 'lead',
};
const WEIGHED: PendingMerge = { ...PENDING, merge: ROW };
const FILE = pendingMergePath(PLACES, 'app', 'feat/login');

describe('pending merges', () => {
  it('keeps one file per branch, its repository and branch encoded into one file name', () => {
    assert.equal(FILE, join(PLACES.pendingMerges, 'app%2Ffeat%2Flogin.json'));
  });

  for (const [name, pending] of [['no merges row', PENDING], ['the merges row it weighed', WEIGHED]] as const) {
    it(`reads back what it wrote with ${name}, and nothing once it is removed`, async () => {
      const files = new MemoryFiles();
      await writePendingMerge(files, PLACES, pending);
      assert.deepEqual(await readPendingMerge(files, PLACES, 'app', 'feat/login'), pending);
      await removePendingMerge(files, PLACES, 'app', 'feat/login');
      assert.equal(await readPendingMerge(files, PLACES, 'app', 'feat/login'), undefined);
    });
  }

  it('writes the pinned fields of its format: a field added to the file raises PENDING_MERGE_FORMAT', () => {
    const merge = ['approvedBy', 'at', 'base', 'branch', 'checks[]', 'files', 'head', 'lines', 'missed[]', 'repo', 'review', 'route', 'session', 'task', 'tree', 'v'].map((field) => `merge.${field}`);
    const written: Readonly<Record<number, readonly string[]>> = {
      1: ['base', 'branch', 'head', 'note', 'repo', 'session', 'since', 'v'],
      2: ['base', 'branch', 'head', ...merge, 'note', 'repo', 'session', 'since', 'v'],
    };
    assert.deepEqual(fieldPaths(JSON.parse(formatPendingMerge(WEIGHED))), written[PENDING_MERGE_FORMAT]);
  });

  it('writes null for a merges row when the self-merge step weighed nothing', () => {
    assert.deepEqual(JSON.parse(formatPendingMerge(PENDING)), { v: PENDING_MERGE_FORMAT, ...PENDING, merge: null });
  });

  it('reads a format 1 file, written before pending merges kept a merges row, as one with none', async () => {
    const files = new MemoryFiles({ [FILE]: JSON.stringify({ v: 1, ...PENDING }) });
    assert.deepEqual(await readPendingMerge(files, PLACES, 'app', 'feat/login'), PENDING);
  });

  it('refuses to overwrite a pending merge a newer teamrig wrote, leaving it as it was', async () => {
    const newer = JSON.stringify({ v: PENDING_MERGE_FORMAT + 1, ...PENDING });
    const files = new MemoryFiles({ [FILE]: newer });
    await assert.rejects(writePendingMerge(files, PLACES, PENDING), (error: unknown) => error instanceof NewerDataError && error.found === PENDING_MERGE_FORMAT + 1 && error.known === PENDING_MERGE_FORMAT);
    assert.equal(files.get(FILE), newer);
  });

  it('overwrites a damaged file', async () => {
    const files = new MemoryFiles({ [FILE]: '{"session":' });
    await writePendingMerge(files, PLACES, PENDING);
    assert.deepEqual(await readPendingMerge(files, PLACES, 'app', 'feat/login'), PENDING);
  });

  it('removes a branch with no pending merge without an error', async () => {
    await removePendingMerge(new MemoryFiles(), PLACES, 'app', 'feat/login');
  });

  const record = (fields: Readonly<Record<string, unknown>>): string => JSON.stringify({ v: PENDING_MERGE_FORMAT, ...PENDING, merge: null, ...fields });

  it('reads the record each unread case below changes', async () => {
    const files = new MemoryFiles({ [FILE]: record({}) });
    assert.deepEqual(await readPendingMerge(files, PLACES, 'app', 'feat/login'), PENDING);
  });

  const row = mergeRecordOf(ROW);
  const unread: readonly { readonly name: string; readonly text: string }[] = [
    { name: 'a format 2 record missing its merges row', text: record({ merge: undefined }) },
    { name: 'a merges row that is not an object', text: record({ merge: 'row' }) },
    { name: 'a merges row of a newer merges format', text: record({ merge: { ...row, v: MERGE_FORMAT + 1 } }) },
    { name: 'a damaged merges row', text: record({ merge: { ...row, files: -1 } }) },
    { name: 'text that is not JSON', text: '{"session":' },
    { name: 'a record missing a field', text: record({ note: undefined }) },
    { name: 'a field of another type', text: record({ head: 7 }) },
    { name: 'a record with no format', text: record({ v: undefined }) },
    { name: 'a newer format', text: record({ v: PENDING_MERGE_FORMAT + 1 }) },
    { name: 'another branch', text: record({ branch: 'feat/other' }) },
    { name: 'another repository', text: record({ repo: 'web' }) },
  ];
  for (const { name, text } of unread) {
    it(`reads no pending merge from ${name}`, async () => {
      const files = new MemoryFiles({ [FILE]: text });
      assert.equal(await readPendingMerge(files, PLACES, 'app', 'feat/login'), undefined);
    });
  }
});
