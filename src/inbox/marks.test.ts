import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { recordVersion } from '../core/jsonl.ts';
import { indexMarks, lastClaudeSessionOf, parseMark, type InboxMark } from './marks.ts';

const SESSION = '0a1b2c3d-1111-2222-3333-444455556666';

function parse(record: JsonRecord) {
  return parseMark({ lineNumber: 1, raw: JSON.stringify(record), record, version: recordVersion(record) ?? 0 });
}

describe('parseMark', () => {
  it('reads v0 marks without a hash and v1 marks with one', () => {
    const v0 = { area: 'alpha', line: 3, at: '2030-01-07T09:00:00.000Z', claudeSession: SESSION };
    assert.deepEqual(parse(v0), { kind: 'mark', mark: { ...v0, v: 0, lastLineHash: null } });
    const v1 = { ...v0, v: 1, claudeSession: null, lastLineHash: 'abcd' };
    assert.deepEqual(parse(v1), { kind: 'mark', mark: v1 });
  });

  it('skips newer marks and rejects malformed ones', () => {
    assert.deepEqual(parse({ v: 2 }), { kind: 'newer' });
    const base = { area: 'alpha', line: 3, at: '2030-01-07T09:00:00.000Z', claudeSession: null };
    for (const bad of [{ area: '../x' }, { line: -1 }, { at: 'soon' }, { claudeSession: 'nope' }, { lastLineHash: 7 }]) {
      assert.deepEqual(parse({ ...base, ...bad }), { kind: 'unreadable' }, JSON.stringify(bad));
    }
  });
});

describe('indexMarks', () => {
  it('keeps the newest mark per area and the newest area per session', () => {
    const at = '2030-01-07T09:00:00.000Z';
    const marks: InboxMark[] = [
      { v: 1, area: 'alpha', line: 1, at, claudeSession: SESSION, lastLineHash: null },
      { v: 1, area: 'bravo', line: 4, at, claudeSession: SESSION, lastLineHash: null },
      { v: 1, area: 'alpha', line: 2, at, claudeSession: null, lastLineHash: null },
    ];
    const index = indexMarks(marks);
    assert.equal(index.byArea.get('alpha')?.line, 2);
    assert.equal(index.areaBySession.get(SESSION), 'bravo');
  });
});

describe('lastClaudeSessionOf', () => {
  it('finds the newest Claude Code session still bound to the area', () => {
    const at = '2030-01-07T09:00:00.000Z';
    const other = 'ffffffff-0000-4000-8000-000000000001';
    const marks: InboxMark[] = [
      { v: 1, area: 'alpha', line: 1, at, claudeSession: other, lastLineHash: null },
      { v: 1, area: 'alpha', line: 2, at, claudeSession: SESSION, lastLineHash: null },
      { v: 1, area: 'bravo', line: 4, at, claudeSession: SESSION, lastLineHash: null },
      { v: 1, area: 'alpha', line: 3, at, claudeSession: null, lastLineHash: null },
    ];
    assert.equal(lastClaudeSessionOf(marks, 'alpha'), other, 'the newer one moved on to bravo');
    assert.equal(lastClaudeSessionOf(marks, 'bravo'), SESSION);
    assert.equal(lastClaudeSessionOf(marks, 'charlie'), undefined);
    assert.equal(lastClaudeSessionOf(marks.slice(3), 'alpha'), undefined);
  });
});
