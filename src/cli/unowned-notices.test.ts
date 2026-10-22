import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { LockBusyError, type Mutex } from '../core/lock.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import {
  formatUnownedNotices,
  freshUnowned,
  parseUnownedNotices,
  toldAfter,
  UNOWNED_FORGET_AFTER_MS,
  UNOWNED_SEEN_REFRESH_MS,
  UnownedNotices,
  type PostUnowned,
} from './unowned-notices.ts';
import type { UnownedWarning } from './unowned.ts';

const PATH = join('/', 'team', 'state', 'unowned-notices.json');
const T0 = Date.parse('2030-01-07T08:00:00.000Z');

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
  it('sees the standing and posted keys now and adds the posted ones once', () => {
    const told = new Map([['a', T0]]);
    const now = T0 + MS_PER_MINUTE;
    assert.deepEqual(
      toldAfter(told, [warning('a'), warning('b')], [warning('b'), warning('a')], now),
      new Map([
        ['a', now],
        ['b', now],
      ]),
    );
  });

  it('keeps a key no start sees until it was unseen for the forget time, then drops it', () => {
    const told = new Map([
      ['kept', T0 + 1],
      ['gone', T0],
    ]);
    assert.deepEqual(toldAfter(told, [], [], T0 + UNOWNED_FORGET_AFTER_MS), new Map([['kept', T0 + 1]]));
  });

  it('starts the clock now for a key with no seen time', () => {
    const told = new Map<string, number | undefined>([['old', undefined]]);
    assert.deepEqual(toldAfter(told, [], [], T0), new Map([['old', T0]]));
  });
});

describe('parseUnownedNotices', () => {
  it('reads its own format back', () => {
    const told = new Map([
      ['a', T0],
      ['b', T0 + 1],
    ]);
    assert.deepEqual(parseUnownedNotices(formatUnownedNotices(told)), told);
  });

  it('reads a key an older teamrig wrote, with no seen time or a damaged one, as having none', () => {
    assert.deepEqual(parseUnownedNotices('{"v":1,"told":["a"]}'), new Map([['a', undefined]]));
    assert.deepEqual(parseUnownedNotices('{"v":1,"told":["a","b"],"seen":{"a":"soon","b":7}}'), new Map([['a', undefined], ['b', undefined]]));
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
    const told = await notices.tell([warning('a'), warning('b')], 5, first.post, T0);
    assert.deepEqual(first.sent, ['a', 'b']);
    assert.deepEqual(
      told.posted.map((item) => item.key),
      ['a', 'b'],
    );
    const second = recorder();
    assert.deepEqual(await notices.tell([warning('a'), warning('b')], 5, second.post, T0 + MS_PER_MINUTE), { posted: [], failed: [] });
    assert.deepEqual(second.sent, []);
    assert.equal(mutex.runs, 1, 'a start with nothing new takes no lock');
  });

  it('tells at most the most per start, and the rest at the next', async () => {
    const notices = new UnownedNotices(new MemoryFiles(), PATH, new CountingMutex());
    const standing = ['a', 'b', 'c'].map(warning);
    const first = recorder();
    await notices.tell(standing, 2, first.post, T0);
    const second = recorder();
    await notices.tell(standing, 2, second.post, T0);
    assert.deepEqual(first.sent, ['a', 'b']);
    assert.deepEqual(second.sent, ['c']);
  });

  it('keeps a warning a start does not see, so the next start that sees it posts nothing', async () => {
    const mutex = new CountingMutex();
    const notices = new UnownedNotices(new MemoryFiles(), PATH, mutex);
    await notices.tell([warning('a')], 5, recorder().post, T0);
    await notices.tell([], 5, recorder().post, T0 + MS_PER_MINUTE);
    assert.equal(mutex.runs, 1, 'a start that does not see a told warning takes no lock');
    const back = recorder();
    await notices.tell([warning('a')], 5, back.post, T0 + 2 * MS_PER_MINUTE);
    assert.deepEqual(back.sent, []);
    assert.deepEqual([...(await notices.told()).keys()], ['a']);
  });

  it('forgets a warning no start saw for the forget time, so it is told again when it returns', async () => {
    const notices = new UnownedNotices(new MemoryFiles(), PATH, new CountingMutex());
    await notices.tell([warning('a')], 5, recorder().post, T0);
    await notices.tell([], 5, recorder().post, T0 + UNOWNED_FORGET_AFTER_MS);
    assert.deepEqual([...(await notices.told()).keys()], []);
    const back = recorder();
    await notices.tell([warning('a')], 5, back.post, T0 + UNOWNED_FORGET_AFTER_MS + MS_PER_MINUTE);
    assert.deepEqual(back.sent, ['a']);
  });

  it('writes a standing warning seen again only once its seen time is older than the refresh time', async () => {
    const files = new MemoryFiles();
    const mutex = new CountingMutex();
    const notices = new UnownedNotices(files, PATH, mutex);
    await notices.tell([warning('a')], 5, recorder().post, T0);
    await notices.tell([warning('a')], 5, recorder().post, T0 + UNOWNED_SEEN_REFRESH_MS - 1);
    assert.equal(mutex.runs, 1);
    const later = T0 + UNOWNED_SEEN_REFRESH_MS;
    const sent = recorder();
    await notices.tell([warning('a')], 5, sent.post, later);
    assert.equal(mutex.runs, 2);
    assert.deepEqual(sent.sent, []);
    assert.equal(files.get(PATH), formatUnownedNotices(new Map([['a', later]])));
  });

  it('stamps a file an older teamrig wrote without seen times, posting nothing', async () => {
    const files = new MemoryFiles();
    await files.write(PATH, '{"v":1,"told":["a","gone"]}\n');
    const notices = new UnownedNotices(files, PATH, new CountingMutex());
    const sent = recorder();
    await notices.tell([warning('a')], 5, sent.post, T0);
    assert.deepEqual(sent.sent, []);
    assert.equal(
      files.get(PATH),
      formatUnownedNotices(
        new Map([
          ['a', T0],
          ['gone', T0],
        ]),
      ),
    );
  });

  it('keeps a refused line untold, so the next start tries again', async () => {
    const notices = new UnownedNotices(new MemoryFiles(), PATH, new CountingMutex());
    const first = recorder(new Set(['a']));
    const told = await notices.tell([warning('a'), warning('b')], 5, first.post, T0);
    assert.deepEqual(told.failed, [{ warning: warning('a'), problem: 'a was refused' }]);
    assert.deepEqual([...(await notices.told()).keys()], ['b']);
    const second = recorder();
    await notices.tell([warning('a'), warning('b')], 5, second.post, T0);
    assert.deepEqual(second.sent, ['a']);
  });

  it('reads a damaged file as nothing told', async () => {
    const files = new MemoryFiles();
    await files.write(PATH, '{not json');
    const notices = new UnownedNotices(files, PATH, new CountingMutex());
    const sent = recorder();
    await notices.tell([warning('a')], 5, sent.post, T0);
    assert.deepEqual(sent.sent, ['a']);
    assert.equal(files.get(PATH), formatUnownedNotices(new Map([['a', T0]])));
  });

  it('passes on a busy lock, posting nothing', async () => {
    const notices = new UnownedNotices(new MemoryFiles(), PATH, busy);
    const sent = recorder();
    await assert.rejects(notices.tell([warning('a')], 5, sent.post, T0), LockBusyError);
    assert.deepEqual(sent.sent, []);
  });
});
