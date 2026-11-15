import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from '../config/roster.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { tabSessionOf } from './tab-session.ts';

const MARKS = '/kit/teams/app/state/inbox-marks.jsonl';
const TAB = '0123abcd-0000-4000-8000-00000000000a';
const OTHER_TAB = 'ffffffff-0000-4000-8000-000000000001';
const ROSTER = new Roster({ sessions: ['lead', 'alpha', 'bravo'], names: { alpha: 'guards' }, roles: { lead: 'lead' } }, 'app');

/** Marks files with one mark per `[area, tab]`. */
async function marked(...marks: readonly (readonly [string, string])[]): Promise<MemoryFiles> {
  const files = new MemoryFiles();
  for (const [area, claudeSession] of marks) {
    await files.append(MARKS, `${JSON.stringify({ v: 1, area, line: 0, at: '2030-01-08T09:00:00.000Z', claudeSession, lastLineHash: null })}\n`);
  }
  return files;
}

describe('tabSessionOf: the session a Claude Code tab is bound to (T2984, C1)', () => {
  it("binds a tab to the one session its marks name, when the call names that session by id or name", async () => {
    const files = await marked(['alpha', TAB], ['bravo', OTHER_TAB], ['alpha', TAB]);
    assert.equal(await tabSessionOf(files, MARKS, ROSTER, TAB, 'alpha'), 'alpha');
    assert.equal(await tabSessionOf(files, MARKS, ROSTER, TAB, 'guards'), 'alpha');
  });

  it('binds nobody for another name, no name, a tab that read two inboxes, no mark, or an area off the roster', async () => {
    const files = await marked(['alpha', TAB]);
    assert.equal(await tabSessionOf(files, MARKS, ROSTER, TAB, 'bravo'), undefined, 'another session');
    assert.equal(await tabSessionOf(files, MARKS, ROSTER, TAB, 'stranger'), undefined, 'no session of the team');
    assert.equal(await tabSessionOf(files, MARKS, ROSTER, TAB, undefined), undefined, 'no name');
    assert.equal(await tabSessionOf(files, MARKS, ROSTER, OTHER_TAB, 'alpha'), undefined, 'a tab with no mark');
    assert.equal(await tabSessionOf(await marked(['alpha', TAB], ['bravo', TAB]), MARKS, ROSTER, TAB, 'alpha'), undefined, 'a tab that read bravo too');
    assert.equal(await tabSessionOf(await marked(['gone', TAB]), MARKS, ROSTER, TAB, 'gone'), undefined, 'an area off the roster');
    assert.equal(await tabSessionOf(new MemoryFiles(), MARKS, ROSTER, TAB, 'alpha'), undefined, 'no marks file');
  });
});
