import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import type { ApprovedMerge, MergeRecord, SelfMerge } from '../merge/merge-log.ts';
import { AGENDA_ROWS, TEAM_ROWS } from './agenda.ts';
import { mergeDigestLines, type MergeDigestInput, type TeamMergeLog } from './merges.ts';

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
  return { own: { log: { records, skipped: 0 }, path: PATH }, below: [], since: SINCE, zone: TimeZone.UTC, gated: true, ...options };
}

const WEB_PATH = '/web/deploys/merges.jsonl';

function webLog(records: readonly MergeRecord[], skipped = 0): TeamMergeLog {
  return { team: 'web', log: { records, skipped }, path: WEB_PATH };
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
    assert.deepEqual(mergeDigestLines(inputOf([SELF], { own: { log: { records: [SELF], skipped: 2 }, path: PATH } })), [`${HEAD}; 2 unreadable line(s) skipped in ${PATH}`, ROW]);
  });

  it('says a self-merge no check proved has no checks', () => {
    assert.match(mergeDigestLines(inputOf([{ ...SELF, checks: [] }]))[1] ?? '', /32 lines, no checks$/);
  });
});

describe('mergeDigestLines: the teams under the lead (T2457)', () => {
  it("lists each team's self-merges after the lead's own by <team>/<session>, check-clean first, and counts them all in the head", () => {
    assert.deepEqual(mergeDigestLines(inputOf([SELF], { below: [webLog([SELF, CHECKED, APPROVED])] })), [
      'MERGES 3 merged with no approval since Mon 01-07 10:00 UTC, 1 CHECK-CLEAN (security samples those weekly)',
      ROW,
      '  Mon 01-07 13:00 UTC web/bravo app t7-auth bbbbbbbb..hhhhhhhh: 2 files, 32 lines, checks unit, lint, CHECK-CLEAN',
      '  Mon 01-07 12:00 UTC web/alpha app t9-feat bbbbbbbb..hhhhhhhh: 2 files, 32 lines, checks unit, lint',
    ]);
  });

  it('collapses a team past the cap to one count line naming its log, with its check-clean count', () => {
    const many = Array.from({ length: TEAM_ROWS }, (_, index) => ({ ...SELF, at: new Date(Date.parse(SELF.at) + index * 60_000).toISOString() }));
    assert.deepEqual(mergeDigestLines(inputOf([], { below: [webLog([...many, CHECKED])] })), [
      `MERGES ${TEAM_ROWS + 1} merged with no approval since Mon 01-07 10:00 UTC, 1 CHECK-CLEAN (security samples those weekly)`,
      `  web: ${TEAM_ROWS + 1} merged with no approval, 1 CHECK-CLEAN: ${WEB_PATH}`,
    ]);
  });

  it("shows a team's merges off gated, and names a team log's unreadable lines", () => {
    assert.deepEqual(mergeDigestLines(inputOf([], { gated: false, below: [webLog([SELF], 1)] })), [
      `${HEAD}; 1 unreadable line(s) skipped in ${WEB_PATH}`,
      '  Mon 01-07 12:00 UTC web/alpha app t9-feat bbbbbbbb..hhhhhhhh: 2 files, 32 lines, checks unit, lint',
    ]);
  });
});
