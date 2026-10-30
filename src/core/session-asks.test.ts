import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { formatSessionAsk, parseSessionAsk, SessionAskStore } from './session-asks.ts';

const FOLDER = join('/', 'team', 'state', 'last-task-asks');
const ASK = { task: 'T4', at: '2030-01-08T10:00:00.000Z' };

describe('SessionAskStore', () => {
  it('keeps one ask per session until it is cleared', async () => {
    const files = new MemoryFiles();
    const store = new SessionAskStore(files, FOLDER);
    assert.equal(await store.get('helper'), undefined);
    await store.set('helper', ASK);
    assert.deepEqual(await store.get('helper'), ASK);
    assert.equal(await store.get('other'), undefined);
    assert.equal(files.paths().length, 1);
    await store.clear('helper');
    assert.equal(await store.get('helper'), undefined);
    await store.clear('helper');
  });

  it('reads a damaged file or another format as no ask', async () => {
    const files = new MemoryFiles();
    const store = new SessionAskStore(files, FOLDER);
    await files.write(join(FOLDER, 'helper.json'), '{"v":1,');
    assert.equal(await store.get('helper'), undefined);
  });
});

describe('parseSessionAsk', () => {
  it('round-trips its own format and refuses anything else', () => {
    assert.deepEqual(parseSessionAsk(formatSessionAsk(ASK)), ASK);
    assert.equal(parseSessionAsk('{"v":2,"task":"T4","at":"x"}'), undefined);
    assert.equal(parseSessionAsk('{"v":1,"task":"T4"}'), undefined);
    assert.equal(parseSessionAsk('{"v":1,"at":"x"}'), undefined);
    assert.equal(parseSessionAsk('[]'), undefined);
  });
});
