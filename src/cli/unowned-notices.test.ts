import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { LockBusyError, type Mutex } from '../core/lock.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { formatUnownedNotices, freshUnowned, parseUnownedNotices, toldAfter, UnownedNotices, type PostUnowned } from './unowned-notices.ts';
import type { UnownedWarning } from './unowned.ts';

const PATH = join('/', 'team', 'state', 'unowned-notices.json');

/** Runs each task at once, counting how often the lock was taken. */
class CountingMutex implements Mutex {
  runs = 0;

  async run<T>(task: () => Promise<T>): Promise<T> {
    this.runs += 1;
    return task();
  }
}

const busy: Mutex = {
  run: () => Promise.reject(new LockBusyError(`${PATH}.lock`, 10)),
};

function warning(key: string): UnownedWarning {
  return { key, source: `the check of ${key}`, text: `WARN ${key}` };
}

/** A post that records each warning it was given and refuses those in `refused`. */
function recorder(refused: ReadonlySet<string> = new Set()): { readonly post: PostUnowned; readonly sent: string[] } {
  const sent: string[] = [];
  const post: PostUnowned = async (item) => {
    sent.push(item.key);
    return refused.has(item.key) ? `${item.key} was refused` : undefined;
  };
  return { post, sent };
}

describe('freshUnowned', () => {
  it('keeps one warning per key, skips told ones and stops at the most', () => {
    const standing = [warning('a'), warning('b'), warning('a'), warning('c'), warning('d')];
    assert.deepEqual(
      freshUnowned(standing, new Set(['b']), 2).map((item) => item.key),
      ['a', 'c'],
    );
    assert.deepEqual(freshUnowned(standing, new Set(['a', 'b', 'c', 'd']), 5), []);
  });
});

describe('toldAfter', () => {
  it('drops told keys that no longer stand and adds the posted ones once', () => {
    assert.deepEqual(toldAfter(new Set(['a', 'gone']), [warning('a'), warning('b')], [warning('b'), warning('a')]), ['a', 'b']);
  });
});

describe('parseUnownedNotices', () => {
  it('reads its own format back', () => {
    assert.deepEqual(parseUnownedNotices(formatUnownedNotices(['a', 'b'])), ['a', 'b']);
  });

  it('reads a damaged file, or one in another format, as undefined', () => {
    assert.equal(parseUnownedNotices('{not json'), undefined);
    assert.equal(parseUnownedNotices('{"v":2,"told":["a"]}'), undefined);
    assert.equal(parseUnownedNotices('{"v":1,"told":[1]}'), undefined);
  });
});

describe('UnownedNotices', () => {
  it('tells each standing warning once, over two starts', async () => {
    const files = new MemoryFiles();
    const mutex = new CountingMutex();
    const notices = new UnownedNotices(files, PATH, mutex);
    const first = recorder();
    const told = await notices.tell([warning('a'), warning('b')], 5, first.post);
    assert.deepEqual(first.sent, ['a', 'b']);
    assert.deepEqual(
      told.posted.map((item) => item.key),
      ['a', 'b'],
    );
    const second = recorder();
    assert.deepEqual(await notices.tell([warning('a'), warning('b')], 5, second.post), { posted: [], failed: [] });
    assert.deepEqual(second.sent, []);
    assert.equal(mutex.runs, 1, 'a start with nothing new takes no lock');
  });

  it('tells at most the most per start, and the rest at the next', async () => {
    const notices = new UnownedNotices(new MemoryFiles(), PATH, new CountingMutex());
    const standing = ['a', 'b', 'c'].map(warning);
    const first = recorder();
    await notices.tell(standing, 2, first.post);
    const second = recorder();
    await notices.tell(standing, 2, second.post);
    assert.deepEqual(first.sent, ['a', 'b']);
    assert.deepEqual(second.sent, ['c']);
  });

  it('forgets a cleared warning, so it is told again when it returns', async () => {
    const files = new MemoryFiles();
    const notices = new UnownedNotices(files, PATH, new CountingMutex());
    await notices.tell([warning('a')], 5, recorder().post);
    await notices.tell([], 5, recorder().post);
    assert.deepEqual([...(await notices.told())], []);
    const back = recorder();
    await notices.tell([warning('a')], 5, back.post);
    assert.deepEqual(back.sent, ['a']);
  });

  it('keeps a refused line untold, so the next start tries again', async () => {
    const notices = new UnownedNotices(new MemoryFiles(), PATH, new CountingMutex());
    const first = recorder(new Set(['a']));
    const told = await notices.tell([warning('a'), warning('b')], 5, first.post);
    assert.deepEqual(told.failed, [{ warning: warning('a'), problem: 'a was refused' }]);
    assert.deepEqual([...(await notices.told())], ['b']);
    const second = recorder();
    await notices.tell([warning('a'), warning('b')], 5, second.post);
    assert.deepEqual(second.sent, ['a']);
  });

  it('reads a damaged file as nothing told', async () => {
    const files = new MemoryFiles();
    await files.write(PATH, '{not json');
    const notices = new UnownedNotices(files, PATH, new CountingMutex());
    const sent = recorder();
    await notices.tell([warning('a')], 5, sent.post);
    assert.deepEqual(sent.sent, ['a']);
    assert.equal(files.get(PATH), formatUnownedNotices(['a']));
  });

  it('passes on a busy lock, posting nothing', async () => {
    const notices = new UnownedNotices(new MemoryFiles(), PATH, busy);
    const sent = recorder();
    await assert.rejects(notices.tell([warning('a')], 5, sent.post), LockBusyError);
    assert.deepEqual(sent.sent, []);
  });
});
