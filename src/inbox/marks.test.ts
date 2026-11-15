import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { recordVersion } from '../core/jsonl.ts';
import { boundElsewhereOf, indexMarks, lastClaudeSessionOf, parseMark, soleAreaOf, type InboxMark } from './marks.ts';

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

describe('boundElsewhereOf', () => {
  it('names the other area on the roster a tab is bound to, and nothing for a read that binds nothing new (T3081)', () => {
    const at = '2030-01-07T09:00:00.000Z';
    const marks: InboxMark[] = [
      { v: 1, area: 'alpha', line: 1, at, claudeSession: SESSION, lastLineHash: null },
      { v: 1, area: 'bravo', line: 2, at, claudeSession: null, lastLineHash: null },
    ];
    const onRoster = (id: string): boolean => id !== 'gone';
    assert.equal(boundElsewhereOf(marks, SESSION, 'bravo', onRoster), 'alpha');
    assert.equal(boundElsewhereOf(marks, SESSION, 'alpha', onRoster), undefined, 'its own area');
    assert.equal(boundElsewhereOf(marks, null, 'bravo', onRoster), undefined, 'no Claude Code session');
    assert.equal(boundElsewhereOf(marks, 'ffffffff-0000-4000-8000-000000000001', 'bravo', onRoster), undefined, 'a tab no mark binds');
    const left: InboxMark[] = [{ v: 1, area: 'gone', line: 0, at, claudeSession: SESSION, lastLineHash: null }];
    assert.equal(boundElsewhereOf(left, SESSION, 'bravo', onRoster), undefined, 'bound to a session that left the roster');
  });
});

describe('soleAreaOf', () => {
  const at = '2030-01-07T09:00:00.000Z';
  const other = 'ffffffff-0000-4000-8000-000000000001';
  const mark = (area: string, claudeSession: string | null): InboxMark => ({ v: 1, area, line: 1, at, claudeSession, lastLineHash: null });

  it('gives the area when every mark of the Claude Code session names it', () => {
    const marks = [mark('alpha', SESSION), mark('bravo', other), mark('alpha', SESSION), mark('bravo', null)];
    assert.equal(soleAreaOf(marks, SESSION), 'alpha');
    assert.equal(soleAreaOf(marks, other), 'bravo');
  });

  it('gives none to a tab that marked two areas, even when its newest names one, or that marked none', () => {
    assert.equal(soleAreaOf([mark('alpha', SESSION), mark('bravo', SESSION), mark('alpha', SESSION)], SESSION), undefined);
    assert.equal(soleAreaOf([mark('alpha', other), mark('alpha', null)], SESSION), undefined);
  });
});
