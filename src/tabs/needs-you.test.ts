import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { TabNeed } from './need.ts';
import { asksFor, isAsking, NeedsYouSent, offersFocus, type AskingTab } from './needs-you.ts';

const SENT = '/team/state/needs-you-sent.json';
const BRAVO: AskingTab = { session: 'bravo', state: 'waiting', kind: 'permission', text: 'Bash: ls', task: null, pid: 7100, since: '2030-01-08T10:00:00.000Z' };
const LEAD: AskingTab = { ...BRAVO, session: 'lead', kind: 'decision', text: 'Decision needed: ship?', since: '2030-01-08T10:01:00.000Z' };
const IDLE: TabNeed = { ...BRAVO, session: 'alpha', state: 'ready', kind: null, text: null };

describe('asksFor', () => {
  it('keeps the asks of other tabs, of the kinds named, newest first', () => {
    assert.equal(isAsking(IDLE), false);
    assert.deepEqual(asksFor([BRAVO, IDLE, LEAD], 'alpha', ['permission', 'decision']), [LEAD, BRAVO]);
    assert.deepEqual(asksFor([BRAVO, LEAD], 'lead', ['permission', 'decision']), [BRAVO]);
    assert.deepEqual(asksFor([BRAVO, LEAD], null, ['decision']), [LEAD]);
  });
});

describe('offersFocus', () => {
  it('offers it outside a meeting, and during one only for a p0 task', () => {
    assert.equal(offersFocus(false, undefined), true);
    assert.equal(offersFocus(true, 0), true);
    assert.equal(offersFocus(true, 1), false);
    assert.equal(offersFocus(true, undefined), false);
  });
});

describe('NeedsYouSent', () => {
  it('names each ask once, a new ask of the same tab again, and forgets tabs that ask nothing now', async () => {
    const files = new MemoryFiles();
    const sent = new NeedsYouSent(files, SENT);
    assert.deepEqual(await sent.markNew([BRAVO, LEAD]), [BRAVO, LEAD]);
    assert.deepEqual(await sent.markNew([BRAVO, LEAD]), []);
    const next = { ...BRAVO, since: '2030-01-08T10:05:00.000Z' };
    assert.deepEqual(await sent.markNew([next]), [next]);
    assert.deepEqual(JSON.parse((await files.read(SENT)) ?? ''), { bravo: next.since });
    assert.deepEqual(await sent.markNew([LEAD]), [LEAD], 'lead was forgotten while it asked nothing');
  });
});
