import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError } from '../core/jsonl.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { INITIAL_MISS_STATE } from './misses.ts';
import { emptyPatterns, INITIAL_PATTERN_STATE } from './patterns.ts';
import { NO_TURN } from './tasks.ts';
import { EMPTY_USAGE, formatUsage, MemoryUsageStore, newCursor, parseUsage, pruneUsage, RECENT_KEYS_KEPT, USAGE_FORMAT, UsageStore, type UsageState } from './store.ts';

const DIR = '/state/usage';
const FILE = '/state/usage/alpha.json';

const DAY = { w: 1_234.5, calls: 7, patterns: { ...emptyPatterns(), readChain: 2 } };
const CALL = { key: 'msg_1|req_1', day: '2026-03-02', hour: '2026-03-02T09', output: 40, context: 5_000, w: 700 };
const TURN = { tasks: ['T7', 'T12'], held: { '2026-03-02': 30 } };
const CURSOR = {
  offset: 900,
  size: 1_000,
  day: '2026-03-02',
  call: CALL,
  patterns: { ...INITIAL_PATTERN_STATE, turn: 3 },
  misses: { lastAt: 1_700_000_000_000, block: { day: '2026-03-02', calls: 2 }, noted: false },
  turn: TURN,
};
const STATE: UsageState = {
  byDay: { '2026-03-02': DAY },
  byHour: { '2026-03-02T09': 1_000, '2026-03-02T10': 234.5 },
  byTask: { '2026-03-02': { T7: 600, T12: 400.5 } },
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
    const store = new UsageStore(new MemoryFiles({ [FILE]: JSON.stringify({ v: USAGE_FORMAT + 1, rev: 1 }) }), DIR);
    await assert.rejects(store.load('alpha'), NewerDataError);
    await assert.rejects(store.save('alpha', STATE, 1), NewerDataError);
  });

  it('reads an older-format file whole and writes it back in its own format, which an older teamrig refuses', async () => {
    const files = new MemoryFiles({ [FILE]: JSON.stringify({ v: 1, rev: 5, ...STATE }) });
    const store = new UsageStore(files, DIR);
    assert.deepEqual(await store.load('alpha'), { rev: 5, state: STATE });
    assert.equal(await store.save('alpha', STATE, 5), true);
    assert.equal(files.get(FILE), formatUsage(STATE, 6));
    assert.ok((files.get(FILE) ?? '').startsWith(`{"v":${USAGE_FORMAT},"rev":6,`));
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
  const stored = { v: 1, rev: 1, byDay: STATE.byDay, byHour: STATE.byHour, byTask: STATE.byTask, cursors: STATE.cursors, recentKeys: STATE.recentKeys };

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
      { ...stored, byHour: 'hours' },
      { ...stored, byHour: { '2026-03-02': 5 } },
      { ...stored, byHour: { '2026-03-02T09': -5 } },
      { ...stored, byTask: 'tasks' },
      { ...stored, byTask: { today: { T7: 1 } } },
      { ...stored, byTask: { '2026-03-02': { t7: 1 } } },
      { ...stored, byTask: { '2026-03-02': { T7: -1 } } },
      { ...stored, cursors: { a: { ...cursor, turn: { tasks: ['x'], held: {} } } } },
      { ...stored, cursors: { '': cursor } },
      { ...stored, cursors: { a: 'cursor' } },
      { ...stored, cursors: { a: { ...cursor, offset: -1 } } },
      { ...stored, cursors: { a: { ...cursor, size: 'big' } } },
      { ...stored, cursors: { a: { ...cursor, day: 'today' } } },
      { ...stored, cursors: { a: { ...cursor, patterns: {} } } },
      { ...stored, cursors: { a: { ...cursor, call: 'open' } } },
      { ...stored, cursors: { a: { ...cursor, misses: 'none' } } },
      { ...stored, cursors: { a: { ...cursor, misses: { lastAt: -1, block: null } } } },
      { ...stored, cursors: { a: { ...cursor, misses: { ...cursor.misses, noted: 'yes' } } } },
      { ...stored, cursors: { a: { ...cursor, call: { ...CALL, key: 5 } } } },
      { ...stored, cursors: { a: { ...cursor, call: { ...CALL, day: 3 } } } },
      { ...stored, cursors: { a: { ...cursor, call: { ...CALL, day: 'today' } } } },
      { ...stored, cursors: { a: { ...cursor, call: { ...CALL, hour: 9 } } } },
      { ...stored, cursors: { a: { ...cursor, call: { ...CALL, hour: '2026-03-01T09' } } } },
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

  it('reads misses stored before start notes as having no note pending, and keeps a pending one (T1529)', () => {
    const { noted: _noted, ...olderMisses } = CURSOR.misses;
    assert.deepEqual(parseUsage(JSON.stringify({ ...stored, v: 3, cursors: { a: { ...CURSOR, misses: olderMisses } } }))?.cursors['a']?.misses, CURSOR.misses);
    const pending: UsageState = { ...STATE, cursors: { a: { ...CURSOR, misses: { lastAt: 1_700_000_000_000, block: null, noted: true } } } };
    assert.deepEqual(parseUsage(formatUsage(pending, 1)), pending);
  });

  it('reads a file and an open call stored before hours were counted as having no hours', () => {
    const { byHour: _byHour, ...olderFile } = stored;
    const { hour: _hour, ...olderCall } = CALL;
    const read = parseUsage(JSON.stringify({ ...olderFile, cursors: { a: { ...CURSOR, call: olderCall } } }));
    assert.deepEqual(read?.byHour, {});
    assert.deepEqual(read?.cursors['a']?.call, { ...CALL, hour: null });
  });

  it('reads a file and a cursor stored before tasks were counted as having no tasks and no open turn', () => {
    const { byTask: _byTask, ...olderFile } = stored;
    const { turn: _turn, ...olderCursor } = CURSOR;
    const read = parseUsage(JSON.stringify({ ...olderFile, v: 2, cursors: { a: olderCursor } }));
    assert.deepEqual(read?.byTask, {});
    assert.deepEqual(read?.cursors['a']?.turn, NO_TURN);
  });

  it('keeps an unkeyed open call', () => {
    const unkeyed = { ...STATE, cursors: { a: { ...newCursor(1, 2, '2026-03-02'), call: { key: null, day: '2026-03-02', hour: null, output: 1, context: 2, w: 3 } } } };
    assert.deepEqual(parseUsage(formatUsage(unkeyed, 1)), unkeyed);
  });
});

describe('usage format', () => {
  /** The maps of a usage file, keyed by day, hour and transcript rather than by field. */
  const MAPS: ReadonlySet<string> = new Set(['byDay', 'byHour', 'byTask', 'byTask.*', 'cursors', 'cursors.*.turn.held']);

  /**
   * The fields each format writes. A teamrig rewrites a file of its own format without a field it does not
   * know, so a field added to the file is a new format: raise USAGE_FORMAT, which an older teamrig refuses,
   * and pin its fields here. Format 1 grew some of these fields by version, so it has no single list.
   */
  const DAY_COUNTERS_2 = [
    'coldCalls',
    'coldW',
    'compactions',
    'editChain',
    'editChainSavedW',
    'editTestJoined',
    'editThenTest',
    'editThenTestSavedW',
    'followupsNone',
    'heavySteps',
    'missAdHocFetch',
    'missCalls',
    'missFollowupWords',
    'missGitWorktreeRemove',
    'missHeavyOutside',
    'missNoStart',
    'notificationTurns',
    'notificationW',
    'otherTurns',
    'otherW',
    'ownerTurns',
    'ownerW',
    'passRentW',
    'passRuns',
    'passTokens',
    'peerTurns',
    'peerW',
    'readChain',
    'readChainW',
    'rerunAfterPass',
    'rerunAfterPassW',
    'rerunFailedFull',
    'rerunFailedFullW',
    'rerunFailedPiped',
    'rerunFailedPipedW',
    'scheduledTurns',
    'scheduledW',
    'subagentTurns',
    'subagentW',
    'workBlocks',
    'worktreeRemoves',
  ];
  const WRITTEN_2 = [
    'byDay.*.calls',
    ...DAY_COUNTERS_2.map((counter) => `byDay.*.patterns.${counter}`),
    'byDay.*.w',
    'byHour.*',
    ...['context', 'day', 'hour', 'key', 'output', 'w'].map((field) => `cursors.*.call.${field}`),
    'cursors.*.day',
    'cursors.*.misses.block.calls',
    'cursors.*.misses.block.day',
    'cursors.*.misses.lastAt',
    'cursors.*.offset',
    'cursors.*.patterns.lastContext',
    ...['failed', 'id', 'kind', 'piped'].map((field) => `cursors.*.patterns.open[].${field}`),
    'cursors.*.patterns.prev.single',
    'cursors.*.patterns.prev.turn',
    'cursors.*.patterns.rentTokens',
    'cursors.*.patterns.trigger',
    'cursors.*.patterns.turn',
    ...['failed', 'id', 'kind', 'piped'].map((field) => `cursors.*.patterns.turnTest.${field}`),
    'cursors.*.size',
    'recentKeys[]',
    'rev',
    'v',
  ];
  const WRITTEN_3 = [...WRITTEN_2, 'byTask.*.*', 'cursors.*.turn.held.*', 'cursors.*.turn.tasks[]'].sort();
  const WRITTEN: Readonly<Record<number, readonly string[]>> = {
    2: WRITTEN_2,
    3: WRITTEN_3,
    4: [...WRITTEN_3, 'cursors.*.misses.noted'].sort(),
  };

  /** A state with every field set, none null, so each nested field shows in its file. */
  const FULL: UsageState = {
    ...STATE,
    cursors: {
      '/t/p/alpha.jsonl': {
        ...CURSOR,
        patterns: {
          turn: 3,
          prev: { turn: 2, single: 'read' },
          open: [{ id: 'toolu_1', kind: 'git', piped: true, failed: null }],
          turnTest: { id: 'toolu_2', kind: 'testTargeted', piped: false, failed: true },
          rentTokens: 120,
          lastContext: 40_000,
          trigger: 'other',
        },
      },
    },
  };

  it('writes the pinned fields of its format: a field added to the file raises USAGE_FORMAT', () => {
    assert.deepEqual(fieldPaths(JSON.parse(formatUsage(FULL, 1)), MAPS), WRITTEN[USAGE_FORMAT]);
    assert.deepEqual(parseUsage(formatUsage(FULL, 1)), FULL);
  });

  it('reads every format from 1 and refuses a newer one', () => {
    for (let format = 1; format <= USAGE_FORMAT; format += 1) {
      assert.deepEqual(parseUsage(JSON.stringify({ v: format, rev: 1, ...FULL })), FULL, `format ${format}`);
    }
    assert.equal(parseUsage(JSON.stringify({ v: USAGE_FORMAT + 1, rev: 1, ...FULL })), undefined);
  });
});

describe('pruneUsage', () => {
  it('keeps 8 days of totals and hours, positions that moved today or yesterday, and the latest call keys', () => {
    const day = DAY;
    const keys = Array.from({ length: RECENT_KEYS_KEPT + 5 }, (_, index) => `k${index}`);
    const state: UsageState = {
      byDay: { '2026-03-01': day, '2026-03-02': day, '2026-03-09': day },
      byHour: { '2026-03-01T23': 1, '2026-03-02T00': 2, '2026-03-09T22': 3 },
      byTask: { '2026-03-01': { T1: 1 }, '2026-03-09': { T1: 2 } },
      cursors: { old: newCursor(1, 1, '2026-03-07'), recent: newCursor(1, 1, '2026-03-08'), today: newCursor(1, 1, '2026-03-09') },
      recentKeys: keys,
    };
    const pruned = pruneUsage(state, Date.parse('2026-03-09T23:00:00Z'));
    assert.deepEqual(Object.keys(pruned.byDay), ['2026-03-02', '2026-03-09']);
    assert.deepEqual(pruned.byHour, { '2026-03-02T00': 2, '2026-03-09T22': 3 });
    assert.deepEqual(pruned.byTask, { '2026-03-09': { T1: 2 } });
    assert.deepEqual(Object.keys(pruned.cursors), ['recent', 'today']);
    assert.deepEqual(pruned.recentKeys, keys.slice(5));
  });
});
