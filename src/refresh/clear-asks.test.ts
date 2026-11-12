import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { askFileOf, holdWhyFileOf, outcomeFileOf } from '../mod/clear-hand.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { ClearAsks, clearAskDir, HOLD_WHY_MAX_CHARS, type ClearAsk, type PostedClearAsk } from './clear-asks.ts';

const DIR = '/kit/clear-asks';
const SESSION = '0123abcd-0000-4000-8000-00000000000a';
const OTHER = '0123abcd-0000-4000-8000-00000000000b';
const OLD_ASK = { team: 'app', id: 'alpha', at: '2030-01-08T09:59:59.000Z', askedAt: '2030-01-08T10:00:15.000Z' };
const ASK: ClearAsk = { ...OLD_ASK, mode: 'clear' };
const POSTED: PostedClearAsk = { ...ASK, hold: { countdownMs: 20_000, afterActivityMs: 300_000 }, askEveryMs: 15_000 };
const ASK_PATH = askFileOf(DIR, SESSION) ?? '';
const OUTCOME_PATH = outcomeFileOf(DIR, SESSION) ?? '';
const HELD_PATH = holdWhyFileOf(DIR, SESSION) ?? '';
const LIVE = '1 agent of this session still live';

describe('ClearAsks', () => {
  it('keeps the folder under the kit home', () => {
    assert.equal(clearAskDir(join('/', 'kit')), join('/', 'kit', 'clear-asks'));
  });

  it('posts an ask with its hold for the mod, and reads it back', async () => {
    const files = new MemoryFiles();
    const asks = new ClearAsks(files, DIR);
    assert.equal(await asks.ask(SESSION), undefined);
    await asks.post(SESSION, POSTED);
    assert.deepEqual(JSON.parse(files.get(ASK_PATH) ?? ''), POSTED, 'the file carries the hold');
    assert.deepEqual(await asks.ask(SESSION), ASK, 'a claim reads the ask without it');
    assert.equal(await asks.ask(OTHER), undefined);
    await files.write(ASK_PATH, JSON.stringify(OLD_ASK));
    assert.deepEqual(await asks.ask(SESSION), ASK, "an older restart's ask, with no hold and no mode, is a /clear");
  });

  it('reads an end ask as one, and any other mode as a /clear (T2444)', async () => {
    const files = new MemoryFiles();
    const asks = new ClearAsks(files, DIR);
    await asks.post(SESSION, { ...POSTED, mode: 'end' });
    assert.equal((await asks.ask(SESSION))?.mode, 'end');
    for (const mode of ['restart', 3, null]) {
      await files.write(ASK_PATH, JSON.stringify({ ...OLD_ASK, mode }));
      assert.equal((await asks.ask(SESSION))?.mode, 'clear', String(mode));
    }
  });

  it('lets the first of an end claim, a claim and a withdraw win (T2444)', async () => {
    const asks = new ClearAsks(new MemoryFiles(), DIR);
    await asks.post(SESSION, { ...POSTED, mode: 'end' });
    assert.equal(await asks.claimEnd(SESSION), true);
    assert.equal(await asks.claim(SESSION), false);
    assert.equal(await asks.withdraw(SESSION), false);
    assert.equal(await asks.outcome(SESSION), 'end');
    await asks.post(OTHER, { ...POSTED, mode: 'end' });
    assert.equal(await asks.withdraw(OTHER), true);
    assert.equal(await asks.claimEnd(OTHER), false);
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
    await asks.post(SESSION, POSTED);
    assert.equal(await asks.outcome(SESSION), undefined);
    assert.equal(await asks.claim(SESSION), true);
    assert.equal(await asks.withdraw(SESSION), false);
    assert.equal(await asks.outcome(SESSION), 'taken');
    await asks.post(OTHER, POSTED);
    assert.equal(await asks.withdraw(OTHER), true);
    assert.equal(await asks.claim(OTHER), false);
    assert.equal(await asks.outcome(OTHER), 'withdrawn');
  });

  it('lets the first of a hold, a claim and a withdraw win', async () => {
    const asks = new ClearAsks(new MemoryFiles(), DIR);
    await asks.post(SESSION, POSTED);
    assert.equal(await asks.hold(SESSION, LIVE), true);
    assert.equal(await asks.claim(SESSION), false);
    assert.equal(await asks.withdraw(SESSION), false);
    assert.equal(await asks.outcome(SESSION), 'held');
    await asks.post(OTHER, POSTED);
    assert.equal(await asks.withdraw(OTHER), true);
    assert.equal(await asks.hold(OTHER, LIVE), false);
    assert.equal(await asks.outcome(OTHER), 'withdrawn');
  });

  it('reads no outcome from a damaged file', async () => {
    const files = new MemoryFiles();
    const asks = new ClearAsks(files, DIR);
    await files.write(OUTCOME_PATH, 'maybe');
    assert.equal(await asks.outcome(SESSION), undefined);
    await files.write(OUTCOME_PATH, 'held\n');
    assert.equal(await asks.outcome(SESSION), 'held');
  });

  it("keeps a hold's reason beside its outcome, which stays the one word an older restart reads", async () => {
    const files = new MemoryFiles();
    const asks = new ClearAsks(files, DIR);
    await asks.post(SESSION, POSTED);
    assert.equal(await asks.heldWhy(SESSION), undefined, 'not held');
    assert.equal(await asks.hold(SESSION, LIVE), true);
    assert.equal(files.get(OUTCOME_PATH), 'held');
    assert.equal(await asks.heldWhy(SESSION), LIVE);
  });

  it("keeps a hold's reason as one line of at most HOLD_WHY_MAX_CHARS, and none for a hold that gives none", async () => {
    const files = new MemoryFiles();
    const asks = new ClearAsks(files, DIR);
    await asks.post(SESSION, POSTED);
    await asks.hold(SESSION, '  the person was active\n\tin this tab   12 s ago\n');
    assert.equal(await asks.heldWhy(SESSION), 'the person was active in this tab 12 s ago');
    await asks.post(SESSION, POSTED);
    await asks.hold(SESSION, 'x'.repeat(HOLD_WHY_MAX_CHARS + 50));
    assert.equal(await asks.heldWhy(SESSION), 'x'.repeat(HOLD_WHY_MAX_CHARS));
    for (const why of [undefined, ' \n ']) {
      await asks.post(SESSION, POSTED);
      assert.equal(await asks.hold(SESSION, why), true);
      assert.equal(files.get(HELD_PATH), undefined, "an older mod's hold, or an empty reason, writes no reason");
      assert.equal(await asks.heldWhy(SESSION), undefined);
    }
  });

  it('starts each ask unclaimed, removing an outcome and a hold reason a run that stopped early left', async () => {
    const asks = new ClearAsks(new MemoryFiles(), DIR);
    assert.equal(await asks.hold(SESSION, LIVE), true);
    await asks.post(SESSION, POSTED);
    assert.equal(await asks.heldWhy(SESSION), undefined, "an earlier round's reason never names this one's hold");
    assert.equal(await asks.claim(SESSION), true);
  });

  it('closes an ask together with its outcome and hold reason', async () => {
    const files = new MemoryFiles();
    const asks = new ClearAsks(files, DIR);
    await asks.post(SESSION, POSTED);
    await asks.hold(SESSION, LIVE);
    await asks.close(SESSION);
    assert.deepEqual([files.get(ASK_PATH), files.get(OUTCOME_PATH), files.get(HELD_PATH)], [undefined, undefined, undefined]);
  });

  it('refuses a session id unsafe in a file name', async () => {
    const asks = new ClearAsks(new MemoryFiles(), DIR);
    await assert.rejects(asks.post('../x', POSTED), /"\.\.\/x" is not a Claude Code session id/);
    await assert.rejects(asks.claim('a b'), /not a Claude Code session id/);
  });
});
