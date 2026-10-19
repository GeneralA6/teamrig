import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { INITIAL_MISS_STATE } from './misses.ts';
import { emptyPatterns, INITIAL_PATTERN_STATE } from './patterns.ts';
import { EMPTY_USAGE, formatUsage, MemoryUsageStore, newCursor, parseUsage, pruneUsage, RECENT_KEYS_KEPT, UsageStore, type UsageState } from './store.ts';

const DIR = '/state/usage';
const FILE = '/state/usage/alpha.json';

const DAY = { w: 1_234.5, calls: 7, patterns: { ...emptyPatterns(), readChain: 2 } };
const CALL = { key: 'msg_1|req_1', day: '2026-03-02', output: 40, context: 5_000, w: 700 };
const CURSOR = { offset: 900, size: 1_000, day: '2026-03-02', call: CALL, patterns: { ...INITIAL_PATTERN_STATE, turn: 3 }, misses: { lastAt: 1_700_000_000_000, block: { day: '2026-03-02', calls: 2 } } };
const STATE: UsageState = {
  byDay: { '2026-03-02': DAY },
  cursors: { '/t/p/alpha.jsonl': CURSOR, '/t/p/alpha/subagents/agent-a.jsonl': newCursor(10, 10, '2026-03-01') },
  recentKeys: ['msg_1|req_1'],
};

describe('UsageStore', () => {
  it('starts empty at revision 0, then saves revision 1 and reads it back', async () => {
    const files = new MemoryFiles();
    const store = new UsageStore(files, DIR);
    assert.deepEqual(await store.load('alpha'), { rev: 0, state: EMPTY_USAGE });
    assert.equal(await store.save('alpha', STATE, 0), true);
    assert.deepEqual(await store.load('alpha'), { rev: 1, state: STATE });
    assert.equal(files.get(FILE), formatUsage(STATE, 1));
  });

  it('writes nothing when another writer saved since the load, so totals and positions revert together', async () => {
    const files = new MemoryFiles({ [FILE]: formatUsage(STATE, 4) });
    const store = new UsageStore(files, DIR);
    assert.equal(await store.save('alpha', EMPTY_USAGE, 3), false);
    assert.equal(files.get(FILE), formatUsage(STATE, 4));
  });

  it('reads a damaged or older file as empty, keeping its revision for the next write', async () => {
    const store = new UsageStore(new MemoryFiles({ '/state/usage/beta.json': 'not json', [FILE]: '{"v":0,"rev":6}' }), DIR);
    assert.deepEqual(await store.load('beta'), { rev: 0, state: EMPTY_USAGE });
    assert.deepEqual(await store.load('alpha'), { rev: 6, state: EMPTY_USAGE });
    assert.equal(await store.save('alpha', STATE, 6), true);
    assert.equal((await store.load('alpha')).rev, 7);
  });

  it('refuses a file a newer version wrote', async () => {
    const store = new UsageStore(new MemoryFiles({ [FILE]: '{"v":2,"rev":1}' }), DIR);
    await assert.rejects(store.load('alpha'), NewerDataError);
    await assert.rejects(store.save('alpha', STATE, 1), NewerDataError);
  });

  it('refuses a session id that is not safe in a file name', async () => {
    const store = new UsageStore(new MemoryFiles(), DIR);
    await assert.rejects(store.load('../alpha'), /is not valid/);
  });
});

describe('MemoryUsageStore', () => {
  it('keeps each session in memory with the same revision check', async () => {
    const store = new MemoryUsageStore();
    assert.deepEqual(await store.load('alpha'), { rev: 0, state: EMPTY_USAGE });
    assert.equal(await store.save('alpha', STATE, 0), true);
    assert.deepEqual(await store.load('alpha'), { rev: 1, state: STATE });
    assert.equal(await store.save('alpha', EMPTY_USAGE, 0), false);
    assert.deepEqual(await store.load('beta'), { rev: 0, state: EMPTY_USAGE });
  });
});

describe('parseUsage', () => {
  const stored = { v: 1, rev: 1, byDay: STATE.byDay, cursors: STATE.cursors, recentKeys: STATE.recentKeys };

  it('round-trips a state', () => {
    assert.deepEqual(parseUsage(formatUsage(STATE, 1)), STATE);
  });

  it('refuses a file with any damaged part', () => {
    const cursor = CURSOR;
    const day = DAY;
    const damaged: readonly unknown[] = [
      [],
      { ...stored, byDay: 'days' },
      { ...stored, byDay: { yesterday: day } },
      { ...stored, byDay: { '2026-03-02': 'day' } },
      { ...stored, byDay: { '2026-03-02': { ...day, w: -1 } } },
      { ...stored, byDay: { '2026-03-02': { ...day, calls: 1.5 } } },
      { ...stored, byDay: { '2026-03-02': { ...day, patterns: {} } } },
      { ...stored, cursors: { '': cursor } },
      { ...stored, cursors: { a: 'cursor' } },
      { ...stored, cursors: { a: { ...cursor, offset: -1 } } },
      { ...stored, cursors: { a: { ...cursor, size: 'big' } } },
      { ...stored, cursors: { a: { ...cursor, day: 'today' } } },
      { ...stored, cursors: { a: { ...cursor, patterns: {} } } },
      { ...stored, cursors: { a: { ...cursor, call: 'open' } } },
      { ...stored, cursors: { a: { ...cursor, misses: 'none' } } },
      { ...stored, cursors: { a: { ...cursor, misses: { lastAt: -1, block: null } } } },
      { ...stored, cursors: { a: { ...cursor, call: { ...CALL, key: 5 } } } },
      { ...stored, cursors: { a: { ...cursor, call: { ...CALL, day: 3 } } } },
      { ...stored, cursors: { a: { ...cursor, call: { ...CALL, day: 'today' } } } },
      { ...stored, cursors: { a: { ...cursor, call: { ...CALL, output: -2 } } } },
      { ...stored, cursors: { a: { ...cursor, call: { ...CALL, context: 0.5 } } } },
      { ...stored, cursors: { a: { ...cursor, call: { ...CALL, w: -3 } } } },
      { ...stored, recentKeys: [1] },
    ];
    for (const value of damaged) {
      assert.equal(parseUsage(JSON.stringify(value)), undefined, JSON.stringify(value));
    }
  });

  it('reads a cursor stored before misses were counted as having seen none', () => {
    const { misses: _misses, ...older } = CURSOR;
    assert.deepEqual(parseUsage(JSON.stringify({ ...stored, cursors: { a: older } }))?.cursors['a'], { ...CURSOR, misses: INITIAL_MISS_STATE });
  });

  it('keeps an unkeyed open call', () => {
    const unkeyed = { ...STATE, cursors: { a: { ...newCursor(1, 2, '2026-03-02'), call: { key: null, day: '2026-03-02', output: 1, context: 2, w: 3 } } } };
    assert.deepEqual(parseUsage(formatUsage(unkeyed, 1)), unkeyed);
  });
});

describe('pruneUsage', () => {
  it('keeps 8 days of totals, positions that moved today or yesterday, and the latest call keys', () => {
    const day = DAY;
    const keys = Array.from({ length: RECENT_KEYS_KEPT + 5 }, (_, index) => `k${index}`);
    const state: UsageState = {
      byDay: { '2026-03-01': day, '2026-03-02': day, '2026-03-09': day },
      cursors: { old: newCursor(1, 1, '2026-03-07'), recent: newCursor(1, 1, '2026-03-08'), today: newCursor(1, 1, '2026-03-09') },
      recentKeys: keys,
    };
    const pruned = pruneUsage(state, Date.parse('2026-03-09T23:00:00Z'));
    assert.deepEqual(Object.keys(pruned.byDay), ['2026-03-02', '2026-03-09']);
    assert.deepEqual(Object.keys(pruned.cursors), ['recent', 'today']);
    assert.deepEqual(pruned.recentKeys, keys.slice(5));
  });
});
