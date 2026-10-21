import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { MERGE_FORMAT, MergeLog, mergeRecordOf, parseMergeRecord, type ApprovedMerge, type SelfMerge } from './merge-log.ts';

const PATH = '/team/deploys/merges.jsonl';
const SELF: SelfMerge = {
  at: '2026-10-21T09:30:00.000Z',
  session: 'alpha',
  repo: 'app',
  branch: 't7-store',
  task: 'T7',
  base: 'b'.repeat(40),
  head: 'h'.repeat(40),
  tree: 'e'.repeat(40),
  files: 2,
  lines: 40,
  checks: ['unit', 'lint'],
  route: 'self',
};
const APPROVED: ApprovedMerge = { ...SELF, branch: 'fix-store', task: undefined, route: 'approved', missed: ['task', 'tests'], approvedBy: 'lead' };

describe('mergeRecordOf and parseMergeRecord', () => {
  it('write each route as a versioned record and read it back the same', () => {
    assert.deepEqual(mergeRecordOf(SELF), { v: MERGE_FORMAT, ...SELF, task: 'T7' });
    assert.deepEqual(mergeRecordOf(APPROVED), { v: MERGE_FORMAT, ...APPROVED, task: null });
    for (const record of [SELF, APPROVED]) {
      assert.deepEqual(parseMergeRecord(mergeRecordOf(record)), record);
    }
  });

  it('reads damaged records as none', () => {
    const self = mergeRecordOf(SELF);
    const approved = mergeRecordOf(APPROVED);
    const damaged = [
      { ...self, at: 'yesterday' },
      { ...self, head: 7 },
      { ...self, task: 7 },
      { ...self, files: -1 },
      { ...self, lines: 1.5 },
      { ...self, checks: 'unit' },
      { ...self, route: 'forced' },
      { ...approved, missed: [] },
      { ...approved, missed: ['task', 'luck'] },
      { ...approved, approvedBy: null },
    ];
    for (const record of damaged) {
      assert.equal(parseMergeRecord(record), undefined, JSON.stringify(record));
    }
  });
});

describe('MergeLog', () => {
  it('appends whole lines, oldest first, and reads them back', async () => {
    const log = new MergeLog(new MemoryFiles(), PATH);
    await log.append(SELF);
    await log.append(APPROVED);
    assert.deepEqual(await log.read(), { records: [SELF, APPROVED], skipped: 0 });
  });

  it('reads nothing from a missing log', async () => {
    assert.deepEqual(await new MergeLog(new MemoryFiles(), PATH).read(), { records: [], skipped: 0 });
  });

  it('skips damaged lines and lines from a newer teamrig, and starts a torn last line anew', async () => {
    const files = new MemoryFiles({ [PATH]: `not json\n{"v":${MERGE_FORMAT},"route":"self"}\n{"v":${MERGE_FORMAT},"at":"2026` });
    const log = new MergeLog(files, PATH);
    await log.append(SELF);
    assert.deepEqual(await log.read(), { records: [SELF], skipped: 3 });
    assert.match(files.get(PATH) ?? '', /"at":"2026\n\{"v":1,"at":"2026-10-21T09:30:00.000Z"/);
  });

  it('refuses to append beside records from a newer teamrig', async () => {
    const files = new MemoryFiles({ [PATH]: `{"v":${MERGE_FORMAT + 1}}\n` });
    await assert.rejects(new MergeLog(files, PATH).append(SELF), NewerDataError);
    assert.deepEqual(await new MergeLog(files, PATH).read(), { records: [], skipped: 1 });
  });
});
