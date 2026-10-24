import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MemoryFiles } from '../testing/memory-files.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { askVerdictOf, ASKS_PER_MS, formatWakeAsk, handedPrompt, handedToast, parseWakeAsk, WakeAsks, type StoredWakeAsk, type WakeAsk } from './asks.ts';
import { wakeCost, wakePrompt, wakeToast } from './decide.ts';

const FOLDER = join('team', 'state', 'wake-asks');
const AT = Date.parse('2030-01-08T10:00:00.000Z');
const MINUTE = 60_000;
const CLOSED: WakeAsk = { from: 'teamrig', text: 'The idle pass closed bravo.', at: AT };
const REOPEN: WakeAsk = { from: 'alpha', text: 'Bravo has a reply waiting.', at: AT + MINUTE };

describe('WakeAsks', () => {
  it("keeps each ask in its own file under its session's folder, read oldest first, two in one millisecond apart", async () => {
    const files = new MemoryFiles();
    const asks = new WakeAsks(files, FOLDER);
    assert.deepEqual(await asks.read('lead'), []);
    await asks.post('lead', REOPEN);
    await asks.post('lead', CLOSED);
    await asks.post('lead', { ...CLOSED, text: 'The idle pass closed alpha.' });
    await asks.post('bravo', CLOSED);
    assert.deepEqual(await asks.read('lead'), [
      { name: `${AT}-0.json`, ask: CLOSED },
      { name: `${AT}-1.json`, ask: { ...CLOSED, text: 'The idle pass closed alpha.' } },
      { name: `${AT + MINUTE}-0.json`, ask: REOPEN },
    ]);
    assert.equal(await files.read(join(FOLDER, 'bravo', `${AT}-0.json`)), formatWakeAsk(CLOSED));
  });

  it('removes only the asks it read, so one posted meanwhile stays', async () => {
    const asks = new WakeAsks(new MemoryFiles(), FOLDER);
    await asks.post('lead', CLOSED);
    const read = await asks.read('lead');
    await asks.post('lead', REOPEN);
    await asks.remove('lead', read);
    assert.deepEqual(await asks.read('lead'), [{ name: `${AT + MINUTE}-0.json`, ask: REOPEN }]);
  });

  it("skips a write's temporary sibling and reads a damaged ask as undefined", async () => {
    const files = new MemoryFiles();
    const asks = new WakeAsks(files, FOLDER);
    await files.write(join(FOLDER, 'lead', `${AT}-0.json.4100.1.tmp`), formatWakeAsk(CLOSED));
    await files.write(join(FOLDER, 'lead', `${AT}-0.json`), '{"v":1,"from":"teamrig"');
    assert.deepEqual(await asks.read('lead'), [{ name: `${AT}-0.json`, ask: undefined }]);
  });

  it(`fails a post past ${ASKS_PER_MS} asks in one millisecond`, async () => {
    const asks = new WakeAsks(new MemoryFiles(), FOLDER);
    for (let n = 0; n < ASKS_PER_MS; n += 1) {
      await asks.post('lead', CLOSED);
    }
    await assert.rejects(asks.post('lead', CLOSED), /lead already has 100 asks posted at 2030-01-08T10:00:00.000Z/);
  });

  it('reads a damaged ask, or one from another format, as undefined', () => {
    const damaged = ['{"v":1,"from":"a","text":"t"', '{"v":2,"from":"a","text":"t","at":1}', '{"v":1,"text":"t","at":1}', '{"v":1,"from":"a","at":1}', '{"v":1,"from":"a","text":"t","at":"1"}'];
    for (const text of damaged) {
      assert.equal(parseWakeAsk(text), undefined, text);
    }
    assert.deepEqual(parseWakeAsk(formatWakeAsk(CLOSED)), CLOSED);
  });
});

describe('askVerdictOf', () => {
  const stored = (...asks: (WakeAsk | undefined)[]): StoredWakeAsk[] => asks.map((ask, n) => ({ name: `${n}`, ask }));

  it('wakes once the oldest ask is a batch old, with every ask', () => {
    const both = stored(CLOSED, REOPEN);
    assert.deepEqual(askVerdictOf(both, AT + MINUTE, 2 * MINUTE), { kind: 'later', at: AT + 2 * MINUTE });
    assert.deepEqual(askVerdictOf(both, AT + 2 * MINUTE, 2 * MINUTE), { kind: 'wake', asks: [CLOSED, REOPEN] });
    assert.deepEqual(askVerdictOf(stored(CLOSED), AT, 0), { kind: 'wake', asks: [CLOSED] });
  });

  it('wakes for none with no ask, or only damaged ones', () => {
    assert.deepEqual(askVerdictOf([], AT, 0), { kind: 'none' });
    assert.deepEqual(askVerdictOf(stored(undefined), AT, 0), { kind: 'none' });
    assert.deepEqual(askVerdictOf(stored(undefined, REOPEN), AT + MINUTE, 0), { kind: 'wake', asks: [REOPEN] });
  });
});

describe('the wake for urgent lines', () => {
  const cost = wakeCost(MINUTE, 60, undefined);
  const task = testTask({ priority: 1, title: 'Fix the login' });

  it("quotes each line on the team's clock, then the work handed meanwhile or the cost", () => {
    assert.equal(
      handedPrompt('lead', [], [CLOSED, REOPEN], cost, JERUSALEM),
      'Urgent lines were posted for you while this tab was idle; act on each now:\n' +
        '- 12:00 IST teamrig: The idle pass closed bravo.\n' +
        '- 12:01 IST alpha: Bravo has a reply waiting.\n' +
        'This wake costs about 27k W, warm cache.',
    );
    assert.equal(handedPrompt('lead', [task], [CLOSED], cost, JERUSALEM), `Urgent lines were posted for you while this tab was idle; act on each now:\n- 12:00 IST teamrig: The idle pass closed bravo.\n${wakePrompt('lead', [task], cost)}`);
    assert.equal(handedPrompt('lead', [task], [], cost, JERUSALEM), wakePrompt('lead', [task], cost));
  });

  it('names the lines, their senders and the tasks in the toast', () => {
    assert.equal(handedToast([], [CLOSED], cost), 'teamrig woke this tab for an urgent line from teamrig (about 27k W, warm cache)');
    assert.equal(handedToast([task], [CLOSED, REOPEN, CLOSED], cost), 'teamrig woke this tab for T1 and 3 urgent lines from teamrig, alpha (about 27k W, warm cache)');
    assert.equal(handedToast([task], [], cost), wakeToast([task], cost));
  });
});
