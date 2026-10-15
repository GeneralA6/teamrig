import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { formatToldNotices, MAX_TOLD, ModelNoticeStore, parseToldNotices } from './model-notices.ts';

const FOLDER = join('/', 'team', 'state', 'model-notices');
const CLAUDE = 'claude-session-1';

describe('ModelNoticeStore', () => {
  it('remembers what one Claude Code session was told, per team session', async () => {
    const files = new MemoryFiles();
    const store = new ModelNoticeStore(files, FOLDER);
    assert.deepEqual(await store.told('alpha', CLAUDE), []);
    await store.remember('alpha', CLAUDE, ['effort:low']);
    await store.remember('alpha', CLAUDE, ['fallback:1', 'fallback:2']);
    assert.deepEqual(await store.told('alpha', CLAUDE), ['effort:low', 'fallback:1', 'fallback:2']);
    assert.deepEqual(await store.told('bravo', CLAUDE), []);
    assert.equal(files.paths().length, 1);
    assert.ok((files.get(join(FOLDER, 'alpha.json')) ?? '').includes('"told":["effort:low","fallback:1","fallback:2"]'));
  });

  it('starts over in a new Claude Code session', async () => {
    const store = new ModelNoticeStore(new MemoryFiles(), FOLDER);
    await store.remember('alpha', CLAUDE, ['effort:low']);
    assert.deepEqual(await store.told('alpha', 'claude-session-2'), []);
    await store.remember('alpha', 'claude-session-2', ['effort:high']);
    assert.deepEqual(await store.told('alpha', 'claude-session-2'), ['effort:high']);
    assert.deepEqual(await store.told('alpha', CLAUDE), []);
  });

  it('keeps only the newest notices', async () => {
    const store = new ModelNoticeStore(new MemoryFiles(), FOLDER);
    const keys = Array.from({ length: MAX_TOLD + 3 }, (_, index) => `fallback:${index}`);
    await store.remember('alpha', CLAUDE, keys);
    assert.deepEqual(await store.told('alpha', CLAUDE), keys.slice(3));
  });

  it('reads a damaged file, or one in another format, as nothing told', async () => {
    const files = new MemoryFiles();
    const store = new ModelNoticeStore(files, FOLDER);
    for (const text of ['not json', '{"v":2,"claude":"claude-session-1","told":["x"]}', '{"v":1,"told":["x"]}', '{"v":1,"claude":"claude-session-1","told":[7]}']) {
      await files.write(join(FOLDER, 'alpha.json'), text);
      assert.deepEqual(await store.told('alpha', CLAUDE), [], text);
    }
  });
});

describe('the notice file format', () => {
  it('reads back what it writes', () => {
    const notices = { claude: CLAUDE, told: ['effort:low'] };
    assert.equal(formatToldNotices(notices), '{"v":1,"claude":"claude-session-1","told":["effort:low"]}\n');
    assert.deepEqual(parseToldNotices(formatToldNotices(notices)), notices);
  });
});
