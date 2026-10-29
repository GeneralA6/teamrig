import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { historyPlaces } from './history-clean.ts';
import { historyCleanFolder, HistoryPending } from './history-pending.ts';
import { PromptSecrets } from './prompt-secrets.ts';

/** Secret-shaped strings are assembled at runtime so none sits in the source for the scrub to flag. */
const join = (...parts: string[]): string => parts.join('');
const TOKEN = join('gh', 'p_', 'a1'.repeat(18));
const KIT = '/kit';
const CLAUDE_DIR = '/u/.claude';
const places = historyPlaces(CLAUDE_DIR);
const secrets = new PromptSecrets();
const blockedPrompt = join('use ', TOKEN, ' for CI');
const found = secrets.secretsIn(blockedPrompt);
const MINUTE = 60 * 1000;

function entry(display: string): string {
  return `${JSON.stringify({ display, pastedContents: {}, timestamp: 1, project: '/work/app', sessionId: 's1' })}\n`;
}

const KEEP = entry('merge T7 once the suite passes');

function pendingNames(files: MemoryFiles): string[] {
  return files.paths().filter((path) => path.startsWith(`${KIT}/history-clean/pending/`));
}

function events(files: MemoryFiles): string[] {
  return (files.get(`${historyCleanFolder(KIT)}/log.jsonl`) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^.*"event":"(\w+)".*$/, '$1'));
}

describe('HistoryPending', () => {
  it('at a block cleans at once and always records the prompt as pending, by hash only', async () => {
    const files = new MemoryFiles({ [places.history]: KEEP + entry(blockedPrompt) });
    const pending = new HistoryPending(files, new FakeClock('2030-01-08T10:00:00Z'), secrets, KIT);

    const clean = await pending.blocked('c1', CLAUDE_DIR, found);

    assert.deepEqual({ lines: clean?.lines, pastes: clean?.pastes }, { lines: 1, pastes: 0 });
    assert.equal(files.get(places.history), KEEP);
    assert.equal(pendingNames(files).length, 1);
    assert.deepEqual(events(files), ['blocked']);
    for (const path of files.paths().filter((name) => name.startsWith(KIT))) {
      assert.equal(files.get(path)?.includes(TOKEN), false, path);
    }
    assert.match(files.get(`${historyCleanFolder(KIT)}/log.jsonl`) ?? '', /"shapes":\["github-token"\],"lines":1,"pastes":0/);
  });

  it('removes a line Claude Code wrote after the block at the next prompt, and settles', async () => {
    const files = new MemoryFiles({ [places.history]: KEEP });
    const clock = new FakeClock('2030-01-08T10:00:00Z');
    const pending = new HistoryPending(files, clock, secrets, KIT);
    await pending.blocked('c1', CLAUDE_DIR, found);
    await files.append(places.history, entry(blockedPrompt));
    clock.advance(MINUTE);

    await pending.sweep();

    assert.equal(files.get(places.history), KEEP);
    assert.deepEqual(pendingNames(files), []);
    assert.deepEqual(events(files), ['blocked', 'cleaned', 'settled']);
  });

  it('keeps a record no clean found a line for until 10 minutes after the block', async () => {
    const files = new MemoryFiles({ [places.history]: KEEP + entry(blockedPrompt) });
    const clock = new FakeClock('2030-01-08T10:00:00Z');
    const pending = new HistoryPending(files, clock, secrets, KIT);
    await pending.blocked('c1', CLAUDE_DIR, found);

    clock.advance(9 * MINUTE);
    await pending.sweep();
    assert.equal(pendingNames(files).length, 1);

    clock.advance(MINUTE);
    await pending.sweep();
    assert.deepEqual(pendingNames(files), []);
    assert.deepEqual(events(files), ['blocked', 'settled']);
  });

  it('drops a record over 24 hours old and a damaged one without cleaning', async () => {
    const files = new MemoryFiles({ [places.history]: KEEP, [`${KIT}/history-clean/pending/1-bad.json`]: 'not json' });
    const clock = new FakeClock('2030-01-08T10:00:00Z');
    const pending = new HistoryPending(files, clock, secrets, KIT);
    await pending.blocked('c1', CLAUDE_DIR, found);
    await files.append(places.history, entry(blockedPrompt));
    clock.advance(24 * 60 * MINUTE + 1);

    await pending.sweep();

    assert.deepEqual(pendingNames(files), []);
    assert.equal(files.get(places.history), KEEP + entry(blockedPrompt));
    assert.deepEqual(events(files), ['blocked', 'expired', 'expired']);
  });

  it('keeps the record and logs the failure when a clean fails', async () => {
    const memory = new MemoryFiles({ [places.history]: KEEP + entry(blockedPrompt) });
    const files = new FaultyFiles(memory).fail('write', places.history, systemError('EPERM'));
    const pending = new HistoryPending(files, new FakeClock('2030-01-08T10:00:00Z'), secrets, KIT);

    assert.equal(await pending.blocked('c1', CLAUDE_DIR, found), undefined);
    await pending.sweep();

    assert.equal(pendingNames(memory).length, 1);
    assert.deepEqual(events(memory), ['failed', 'failed']);
  });
});
