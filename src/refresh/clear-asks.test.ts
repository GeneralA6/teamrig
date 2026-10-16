import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { askFileOf, outcomeFileOf } from '../mod/clear-hand.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { ClearAsks, clearAskDir, type ClearAsk } from './clear-asks.ts';

const DIR = '/kit/clear-asks';
const SESSION = '0123abcd-0000-4000-8000-00000000000a';
const OTHER = '0123abcd-0000-4000-8000-00000000000b';
const ASK: ClearAsk = { team: 'app', id: 'alpha', at: '2030-01-08T09:59:59.000Z', askedAt: '2030-01-08T10:00:15.000Z' };
const ASK_PATH = askFileOf(DIR, SESSION) ?? '';
const OUTCOME_PATH = outcomeFileOf(DIR, SESSION) ?? '';

describe('ClearAsks', () => {
  it('keeps the folder under the kit home', () => {
    assert.equal(clearAskDir(join('/', 'kit')), join('/', 'kit', 'clear-asks'));
  });

  it('posts an ask and reads it back', async () => {
    const asks = new ClearAsks(new MemoryFiles(), DIR);
    assert.equal(await asks.ask(SESSION), undefined);
    await asks.post(SESSION, ASK);
    assert.deepEqual(await asks.ask(SESSION), ASK);
    assert.equal(await asks.ask(OTHER), undefined);
  });

  it('reads no ask from a damaged file, or one whose team or id would leave its folder', async () => {
    const files = new MemoryFiles();
    const asks = new ClearAsks(files, DIR);
    for (const text of ['not json', '[]', JSON.stringify({ ...ASK, askedAt: 3 }), JSON.stringify({ ...ASK, team: '../x' }), JSON.stringify({ ...ASK, id: 'a/b' })]) {
      await files.write(ASK_PATH, text);
      assert.equal(await asks.ask(SESSION), undefined, text);
    }
  });

  it('lets the first of a claim and a withdraw win', async () => {
    const asks = new ClearAsks(new MemoryFiles(), DIR);
    await asks.post(SESSION, ASK);
    assert.equal(await asks.taken(SESSION), false);
    assert.equal(await asks.claim(SESSION), true);
    assert.equal(await asks.withdraw(SESSION), false);
    assert.equal(await asks.taken(SESSION), true);
    await asks.post(OTHER, ASK);
    assert.equal(await asks.withdraw(OTHER), true);
    assert.equal(await asks.claim(OTHER), false);
    assert.equal(await asks.taken(OTHER), false);
  });

  it('starts each ask unclaimed, removing an outcome a run that stopped early left', async () => {
    const asks = new ClearAsks(new MemoryFiles(), DIR);
    assert.equal(await asks.withdraw(SESSION), true);
    await asks.post(SESSION, ASK);
    assert.equal(await asks.claim(SESSION), true);
  });

  it('closes an ask together with its outcome', async () => {
    const files = new MemoryFiles();
    const asks = new ClearAsks(files, DIR);
    await asks.post(SESSION, ASK);
    await asks.claim(SESSION);
    await asks.close(SESSION);
    assert.deepEqual([files.get(ASK_PATH), files.get(OUTCOME_PATH)], [undefined, undefined]);
  });

  it('refuses a session id unsafe in a file name', async () => {
    const asks = new ClearAsks(new MemoryFiles(), DIR);
    await assert.rejects(asks.post('../x', ASK), /"\.\.\/x" is not a Claude Code session id/);
    await assert.rejects(asks.claim('a b'), /not a Claude Code session id/);
  });
});
