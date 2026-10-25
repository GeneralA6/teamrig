import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MemoryFiles } from '../testing/memory-files.ts';
import { formatWakePrompt, parseWakePrompt, WakePrompts, type WakePrompt } from './prompts.ts';

const FOLDER = join('team', 'state', 'wake');
const WOKE: WakePrompt = { tab: 'tab-1', text: 'New work was handed to you while this tab was idle: T2.' };

describe('WakePrompts', () => {
  it("keeps each session's last wake in its own file beside its wake state, the later wake in place of the earlier", async () => {
    const files = new MemoryFiles();
    const prompts = new WakePrompts(files, FOLDER);
    assert.equal(await prompts.read('alpha'), undefined);
    await prompts.remember('alpha', { tab: 'tab-1', text: 'first' });
    await prompts.remember('alpha', WOKE);
    await prompts.remember('bravo', { tab: 'tab-2', text: 'other' });
    assert.deepEqual(await prompts.read('alpha'), WOKE);
    assert.deepEqual(parseWakePrompt(files.get(join(FOLDER, 'alpha.prompt.json')) ?? ''), WOKE);
    assert.deepEqual(await prompts.read('bravo'), { tab: 'tab-2', text: 'other' });
  });

  it('takes the wake once, for its own tab and its exact text, outer white space aside', async () => {
    const files = new MemoryFiles();
    const prompts = new WakePrompts(files, FOLDER);
    await prompts.remember('alpha', WOKE);
    assert.equal(await prompts.take('alpha', { tab: 'tab-2', text: WOKE.text }), false, 'another tab of the session');
    assert.equal(await prompts.take('alpha', { tab: 'tab-1', text: 'New work was handed to you: T2.' }), false, 'other words');
    assert.equal(await prompts.take('bravo', WOKE), false, 'another session');
    assert.deepEqual(await prompts.read('alpha'), WOKE, 'kept while no prompt matched');
    assert.equal(await prompts.take('alpha', { tab: 'tab-1', text: `${WOKE.text}\n` }), true);
    assert.equal(await prompts.read('alpha'), undefined);
    assert.equal(await prompts.take('alpha', WOKE), false, 'the same text typed again is the person’s');
  });

  it('forgets a dropped wake of its own tab only', async () => {
    const files = new MemoryFiles();
    const prompts = new WakePrompts(files, FOLDER);
    await prompts.remember('alpha', WOKE);
    await prompts.forget('alpha', 'tab-2');
    assert.deepEqual(await prompts.read('alpha'), WOKE);
    await prompts.forget('alpha', 'tab-1');
    assert.equal(await prompts.read('alpha'), undefined);
    await prompts.forget('alpha', 'tab-1');
  });

  it('reads a damaged file or one of another format as no wake, which takes no prompt', async () => {
    const files = new MemoryFiles();
    const prompts = new WakePrompts(files, FOLDER);
    const path = join(FOLDER, 'alpha.prompt.json');
    for (const text of ['{not json', JSON.stringify({ v: 2, tab: 'tab-1', text: WOKE.text }), JSON.stringify({ v: 1, tab: 'tab-1' })]) {
      await files.write(path, text);
      assert.equal(await prompts.read('alpha'), undefined, text);
      assert.equal(await prompts.take('alpha', WOKE), false, text);
    }
    assert.equal(formatWakePrompt(WOKE), `${JSON.stringify({ v: 1, ...WOKE })}\n`);
  });
});
