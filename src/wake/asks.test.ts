import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseObject } from '../core/jsonl.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { testTask } from '../testing/task.ts';
import { JERUSALEM } from '../testing/zone.ts';
import {
  askVerdictOf,
  ASKS_PER_MS,
  asksNowOf,
  formatWakeAsk,
  handedPrompt,
  handedToast,
  parseWakeAsk,
  TIMED_ASK_FORMAT,
  urgentFirstPrompt,
  WAKE_ASK_FORMAT,
  WakeAsks,
  type AsksNow,
  type StoredWakeAsk,
  type WakeAsk,
} from './asks.ts';
import { wakeCost, wakePrompt, wakeToast } from './decide.ts';

const FOLDER = join('team', 'state', 'wake-asks');
const AT = Date.parse('2030-01-08T10:00:00.000Z');
const MINUTE = 60_000;
const CLOSED: WakeAsk = { from: 'teamrig', text: 'The idle pass closed bravo.', at: AT };
const REOPEN: WakeAsk = { from: 'alpha', text: 'Bravo has a reply waiting.', at: AT + MINUTE };
const TIMED: WakeAsk = { from: 'lead', text: 'Answer on T7 by noon.', at: AT, by: { at: AT + 10 * MINUTE, line: 'a1b2c3d4e5f60718' } };

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
    const damaged = [
      '{"v":1,"from":"a","text":"t"',
      '{"v":3,"from":"a","text":"t","at":1}',
      '{"v":1,"text":"t","at":1}',
      '{"v":1,"from":"a","at":1}',
      '{"v":1,"from":"a","text":"t","at":"1"}',
      '{"v":2,"from":"a","text":"t","at":1,"line":"x"}',
      '{"v":2,"from":"a","text":"t","at":1,"dueAt":2}',
    ];
    for (const text of damaged) {
      assert.equal(parseWakeAsk(text), undefined, text);
    }
    assert.deepEqual(parseWakeAsk(formatWakeAsk(CLOSED)), CLOSED);
    assert.deepEqual(parseWakeAsk(formatWakeAsk(TIMED)), TIMED);
  });

  it('writes the pinned fields of each format, a plain ask in the one an older teamrig reads: a field added raises its format', () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      [WAKE_ASK_FORMAT]: ['at', 'from', 'text', 'v'],
      [TIMED_ASK_FORMAT]: ['at', 'dueAt', 'from', 'line', 'text', 'v'],
    };
    assert.deepEqual(fieldPaths(parseObject(formatWakeAsk(CLOSED).trim())), written[WAKE_ASK_FORMAT]);
    assert.deepEqual(fieldPaths(parseObject(formatWakeAsk(TIMED).trim())), written[TIMED_ASK_FORMAT]);
    assert.equal(parseObject(formatWakeAsk(CLOSED).trim())?.['v'], WAKE_ASK_FORMAT);
  });
});

describe('asksNowOf', () => {
  const stored = (...asks: (WakeAsk | undefined)[]): StoredWakeAsk[] => asks.map((ask, n) => ({ name: `${n}`, ask }));
  /** The session's unseen lines, `hashes`, and how many times they were read. */
  const lines = (...hashes: string[]): { readonly unseen: () => Promise<ReadonlySet<string>>; readonly calls: () => number } => {
    let calls = 0;
    const unseen = async (): Promise<ReadonlySet<string>> => {
      calls += 1;
      return new Set(hashes);
    };
    return { unseen, calls: () => calls };
  };

  it('takes plain asks at once, spends damaged ones, and holds a timed ask until its time without reading the inbox', async () => {
    const inbox = lines(TIMED.by?.line ?? '');
    const all = stored(CLOSED, undefined, TIMED, { ...TIMED, by: { at: AT + 5 * MINUTE, line: 'other' } });
    const found = await asksNowOf(all, AT + MINUTE, inbox.unseen);
    assert.deepEqual(found, { asks: [CLOSED], taken: [all[0], all[1]], spent: [all[1]], nextAt: AT + 5 * MINUTE });
    assert.equal(inbox.calls(), 0);
  });

  it('takes a timed ask due while its line is unseen, else spends it, reading the inbox once', async () => {
    const due = stored(TIMED, { ...TIMED, text: 'Seen already.', by: { at: AT, line: 'seen' } });
    const inbox = lines(TIMED.by?.line ?? '');
    assert.deepEqual(await asksNowOf(due, AT + 10 * MINUTE, inbox.unseen), { asks: [TIMED], taken: [due[0], due[1]], spent: [due[1]], nextAt: undefined });
    assert.equal(inbox.calls(), 1);
    assert.deepEqual(await asksNowOf(due, AT + 10 * MINUTE, lines().unseen), { asks: [], taken: due, spent: due, nextAt: undefined });
  });
});

describe('askVerdictOf', () => {
  const found = (asks: readonly WakeAsk[], nextAt?: number): AsksNow => ({ asks, taken: [], spent: [], nextAt });

  it('wakes once the oldest ask is a batch old, with every ask', () => {
    const both = found([CLOSED, REOPEN]);
    assert.deepEqual(askVerdictOf(both, AT + MINUTE, 2 * MINUTE), { kind: 'later', at: AT + 2 * MINUTE });
    assert.deepEqual(askVerdictOf(both, AT + 2 * MINUTE, 2 * MINUTE), { kind: 'wake', asks: [CLOSED, REOPEN] });
    assert.deepEqual(askVerdictOf(found([CLOSED]), AT, 0), { kind: 'wake', asks: [CLOSED] });
  });

  it('wakes at once for a timed ask due, its time being the batch', () => {
    assert.deepEqual(askVerdictOf(found([TIMED]), AT + 10 * MINUTE, 30 * MINUTE), { kind: 'wake', asks: [TIMED] });
    assert.deepEqual(askVerdictOf(found([REOPEN, TIMED]), AT + 10 * MINUTE, 30 * MINUTE), { kind: 'wake', asks: [REOPEN, TIMED] });
  });

  it('wakes for none with no ask, or looks again when a timed ask comes due', () => {
    assert.deepEqual(askVerdictOf(found([]), AT, 0), { kind: 'none' });
    assert.deepEqual(askVerdictOf(found([], AT + 5 * MINUTE), AT, 0), { kind: 'later', at: AT + 5 * MINUTE });
    assert.deepEqual(askVerdictOf(found([CLOSED], AT + MINUTE), AT, 2 * MINUTE), { kind: 'later', at: AT + MINUTE });
    assert.deepEqual(askVerdictOf(found([CLOSED], AT + 5 * MINUTE), AT, 2 * MINUTE), { kind: 'later', at: AT + 2 * MINUTE });
  });
});

describe('the wake for urgent lines', () => {
  const cost = wakeCost(MINUTE, 60, undefined, undefined);
  const task = testTask({ priority: 1, title: 'Fix the login' });

  it("quotes each line on the team's clock, then the work handed meanwhile or the cost", () => {
    assert.equal(
      handedPrompt('lead', [], [CLOSED, REOPEN], cost, JERUSALEM),
      'Urgent lines were posted for you while this tab was idle; act on each now:\n' +
        '- 12:00 IST teamrig: The idle pass closed bravo.\n' +
        '- 12:01 IST alpha: Bravo has a reply waiting.\n' +
        'This wake costs at least about 27k W for the first call, warm cache; whole turns usually cost more.',
    );
    assert.equal(handedPrompt('lead', [task], [CLOSED], cost, JERUSALEM), `Urgent lines were posted for you while this tab was idle; act on each now:\n- 12:00 IST teamrig: The idle pass closed bravo.\n${wakePrompt('lead', [task], cost)}`);
    assert.equal(handedPrompt('lead', [task], [], cost, JERUSALEM), wakePrompt('lead', [task], cost));
  });

  it("quotes the lines posted while closed ahead of a reopened session's own first prompt, or counts them when that is too long", () => {
    const quoted = 'Urgent lines were posted for you while you were closed; act on each first:\n- 12:00 IST teamrig: The idle pass closed bravo.\n- 12:01 IST alpha: Bravo has a reply waiting.\nStart your first open task.';
    assert.equal(urgentFirstPrompt([CLOSED, REOPEN], 'Start your first open task.', JERUSALEM, quoted.length), quoted);
    assert.equal(
      urgentFirstPrompt([CLOSED, REOPEN, CLOSED], 'Start your first open task.', JERUSALEM, 100),
      'Posted for you while you were closed, in your inbox: 3 urgent lines from teamrig, alpha; act on each first.\nStart your first open task.',
    );
    assert.equal(urgentFirstPrompt([], 'Start your first open task.', JERUSALEM, 100), 'Start your first open task.');
  });

  it('names the lines, their senders and the tasks in the toast', () => {
    assert.equal(handedToast([], [CLOSED], cost), 'teamrig woke this tab for an urgent line from teamrig (at least about 27k W for the first call, warm cache; whole turns usually cost more)');
    assert.equal(handedToast([task], [CLOSED, REOPEN, CLOSED], cost), 'teamrig woke this tab for T1 and 3 urgent lines from teamrig, alpha (at least about 27k W for the first call, warm cache; whole turns usually cost more)');
    assert.equal(handedToast([task], [], cost), wakeToast([task], cost));
  });
});
