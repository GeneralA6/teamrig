import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import type { ApprovedMerge, MergeRecord, SelfMerge } from '../merge/merge-log.ts';
import { AGENDA_ROWS } from './agenda.ts';
import { mergeDigestLines, type MergeDigestInput } from './merges.ts';

const SINCE = Date.parse('2030-01-07T10:00:00Z');
const PATH = '/team/deploys/merges.jsonl';
const HEAD = 'MERGES 1 merged with no approval since Mon 01-07 10:00 UTC, 0 CHECK-CLEAN (security samples those weekly)';
const SELF: SelfMerge = {
  at: '2030-01-07T12:00:00.000Z',
  session: 'alpha',
  repo: 'app',
  branch: 't9-feat',
  task: 'T9',
  base: 'b'.repeat(40),
  head: 'h'.repeat(40),
  tree: 'e'.repeat(40),
  files: 2,
  lines: 32,
  checks: ['unit', 'lint'],
  review: 'untouched',
  route: 'self',
};
const ROW = '  Mon 01-07 12:00 UTC alpha app t9-feat bbbbbbbb..hhhhhhhh: 2 files, 32 lines, checks unit, lint';
const CHECKED: SelfMerge = { ...SELF, at: '2030-01-07T13:00:00.000Z', session: 'bravo', branch: 't7-auth', review: 'checked' };
const APPROVED: ApprovedMerge = { ...SELF, review: 'approved', route: 'approved', missed: ['pass'], approvedBy: 'lead' };

function inputOf(records: readonly MergeRecord[], options: Partial<MergeDigestInput> = {}): MergeDigestInput {
  return { log: { records, skipped: 0 }, since: SINCE, zone: TimeZone.UTC, gated: true, path: PATH, ...options };
}

describe('mergeDigestLines', () => {
  it('lists the self-merges since the meeting before, check-clean ones first and marked, and no approved merge', () => {
    const older: SelfMerge = { ...SELF, at: '2030-01-07T09:59:00.000Z', branch: 't3-old' };
    assert.deepEqual(mergeDigestLines(inputOf([older, SELF, APPROVED, CHECKED])), [
      'MERGES 2 merged with no approval since Mon 01-07 10:00 UTC, 1 CHECK-CLEAN (security samples those weekly)',
      '  Mon 01-07 13:00 UTC bravo app t7-auth bbbbbbbb..hhhhhhhh: 2 files, 32 lines, checks unit, lint, CHECK-CLEAN',
      ROW,
    ]);
  });

  it('says none merged under gated, and prints nothing off it unless its window holds a self-merge', () => {
    assert.deepEqual(mergeDigestLines(inputOf([APPROVED])), ['MERGES 0 merged with no approval since Mon 01-07 10:00 UTC, 0 CHECK-CLEAN (security samples those weekly)']);
    assert.deepEqual(mergeDigestLines(inputOf([], { gated: false })), []);
    assert.deepEqual(mergeDigestLines(inputOf([{ ...SELF, at: '2030-01-06T12:00:00.000Z' }], { gated: false })), []);
    assert.deepEqual(mergeDigestLines(inputOf([SELF], { gated: false })), [HEAD, ROW]);
  });

  it('caps the rows, never cutting a check-clean one, and names the log for the rest', () => {
    const many = Array.from({ length: AGENDA_ROWS + 2 }, (_, index) => ({ ...SELF, at: new Date(Date.parse(SELF.at) + index * 60_000).toISOString() }));
    const lines = mergeDigestLines(inputOf([...many, { ...CHECKED, at: '2030-01-07T23:00:00.000Z' }]));
    assert.equal(lines.length, 1 + AGENDA_ROWS + 1);
    assert.match(lines[1] ?? '', /t7-auth .*, CHECK-CLEAN$/);
    assert.equal(lines.at(-1), `  +3 more: ${PATH}`);
  });

  it('names the lines of the log it could not read', () => {
    assert.deepEqual(mergeDigestLines(inputOf([SELF], { log: { records: [SELF], skipped: 2 } })), [`${HEAD}; 2 unreadable line(s) skipped in ${PATH}`, ROW]);
  });

  it('says a self-merge no check proved has no checks', () => {
    assert.match(mergeDigestLines(inputOf([{ ...SELF, checks: [] }]))[1] ?? '', /32 lines, no checks$/);
  });
});
