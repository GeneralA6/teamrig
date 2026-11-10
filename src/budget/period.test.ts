import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BudgetConfig } from '../config/types.ts';
import { NewerDataError } from '../core/jsonl.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import {
  formatPeriod,
  LATE_START_PTS,
  LATE_START_RATIO,
  nextPeriod,
  parsePeriod,
  PERIOD_FORMAT,
  PeriodStore,
  RESET_DROP_PTS,
  sightOf,
  type Metered,
  type Period,
} from './period.ts';
import type { WeekUse } from './snapshot.ts';

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const END = Date.parse('2026-10-21T01:00:00Z');
const START = Date.parse('2026-10-14T01:00:00Z');
const NOW = Date.parse('2026-10-19T12:00:00Z');
/** The week from Wednesday 10-14 01:00 to Wednesday 10-21 01:00, last read at 55% by 11:00 on Monday. */
const STORED: Period = { start: START, end: END, kind: 'week', lastPct: 55, lastAt: NOW - HOUR };

/** Memory files that count their writes. */
class CountingFiles extends MemoryFiles {
  writes = 0;

  override async write(path: string, text: string): Promise<void> {
    this.writes += 1;
    await super.write(path, text);
  }
}

function use(usedPct: number, at: number, resetsAt = END, after?: number): WeekUse {
  return after === undefined ? { usedPct, resetsAt, at } : { usedPct, resetsAt, at, after };
}

/** Metered W at 1M W per percent: `pctPerHour` percent in each hour from `from` to `to`, both on the hour. */
function flat(pctPerHour: number, from: number, to: number): Metered {
  const wPerPct = 1_000_000;
  return { wPerPct, wFrom: (at) => (Math.max(0, to - Math.max(from, at - (at % HOUR))) / HOUR) * pctPerHour * wPerPct };
}

/** 1% an hour since Wednesday 01:00: 131% by Monday noon. */
const SINCE_WEDNESDAY = flat(1, START, NOW);
/** Where that W reaches a 55% reading at noon: 55 hours before. */
const INFERRED: Period = { start: NOW - 55 * HOUR, end: END, kind: 'inferred', lastPct: 55, lastAt: NOW };

describe('nextPeriod', () => {
  it('guesses the week before the end when no period is stored', () => {
    assert.deepEqual(nextPeriod(undefined, { end: END, use: use(55, NOW) }), { start: START, end: END, kind: 'assumed', lastPct: 55, lastAt: NOW });
    assert.deepEqual(nextPeriod(undefined, { end: END, use: undefined }), { start: START, end: END, kind: 'assumed', lastPct: 0, lastAt: START });
  });

  it('opens the next week at the end of the one that ended, case a', () => {
    const after = END + 2 * HOUR;
    assert.deepEqual(nextPeriod(STORED, { end: END + WEEK, use: use(1, after, END + WEEK) }), { start: END, end: END + WEEK, kind: 'week', lastPct: 1, lastAt: after });
    // Before any reading of the new week: from the config's next reset, a minute off the plan's.
    assert.deepEqual(nextPeriod(STORED, { end: END + WEEK - 60_000, use: undefined }), { start: END, end: END + WEEK - 60_000, kind: 'week', lastPct: 0, lastAt: END });
  });

  it('guesses again when weeks went unseen, or when the end comes before the start', () => {
    assert.deepEqual(nextPeriod(STORED, { end: END + 2 * WEEK, use: undefined }), { start: END + WEEK, end: END + 2 * WEEK, kind: 'assumed', lastPct: 0, lastAt: END + WEEK });
    assert.equal(nextPeriod(STORED, { end: START - HOUR, use: undefined }).kind, 'assumed');
  });

  it(`opens a new budget from the latest reading when a later one falls ${RESET_DROP_PTS} points or more, case b`, () => {
    assert.deepEqual(nextPeriod(STORED, { end: END, use: use(0.4, NOW) }), { start: STORED.lastAt, end: END, kind: 'reset', lastPct: 0.4, lastAt: NOW });
    assert.deepEqual(nextPeriod(STORED, { end: END, use: use(55 - RESET_DROP_PTS, NOW) }).kind, 'reset');
    // A guessed start that moved past the latest reading bounds the new budget's start.
    const guessed: Period = { ...STORED, kind: 'assumed', lastAt: START + HOUR };
    assert.equal(nextPeriod(guessed, { end: END + 2 * HOUR, use: use(1, NOW) }).start, START + 2 * HOUR);
  });

  it('keeps the start for a smaller fall, a reading older than its latest, or no reading', () => {
    assert.deepEqual(nextPeriod(STORED, { end: END, use: use(54, NOW) }), { ...STORED, lastPct: 54, lastAt: NOW });
    assert.deepEqual(nextPeriod(STORED, { end: END, use: use(1, NOW - 2 * HOUR) }), STORED);
    assert.deepEqual(nextPeriod(STORED, { end: END, use: undefined }), STORED);
  });

  it('keeps a known start when the end moves, and moves a guessed one with it, case d', () => {
    const later = END + 5 * HOUR;
    assert.deepEqual(nextPeriod(STORED, { end: later, use: use(56, NOW, later) }), { ...STORED, end: later, lastPct: 56, lastAt: NOW });
    assert.deepEqual(nextPeriod(STORED, { end: END - HOUR, use: undefined }), { ...STORED, end: END - HOUR });
    const guessed: Period = { ...STORED, kind: 'assumed' };
    assert.deepEqual(nextPeriod(guessed, { end: later, use: undefined }), { ...guessed, start: later - WEEK, end: later });
  });
});

describe('nextPeriod, a reading that may predate a reset inside the week (T2019)', () => {
  /** The budget a reset opened two hours ago, read at 0% an hour ago. */
  const RESET: Period = { start: NOW - 2 * HOUR, end: END, kind: 'reset', lastPct: 0, lastAt: NOW - HOUR };
  const LONG_BEFORE = NOW - 3 * HOUR;

  it('leaves out the old use a session shows late, so the next true reading opens no second reset', () => {
    const kept = nextPeriod(RESET, { end: END, use: use(29, NOW, END, LONG_BEFORE) });
    assert.deepEqual(kept, RESET);
    const after = NOW + 2 * 60_000;
    assert.deepEqual(nextPeriod(kept, { end: END, use: use(0, after, END, NOW) }), { ...RESET, lastAt: after });
  });

  it('takes a rise read after the latest reading, or at that moment', () => {
    assert.deepEqual(nextPeriod(RESET, { end: END, use: use(29, NOW, END, NOW - 1000) }), { ...RESET, lastPct: 29, lastAt: NOW });
    assert.deepEqual(nextPeriod(RESET, { end: END, use: use(29, NOW, END, RESET.lastAt) }), { ...RESET, lastPct: 29, lastAt: NOW });
  });

  it("takes a session's first reading, whose earliest moment is not known", () => {
    assert.deepEqual(nextPeriod(RESET, { end: END, use: use(29, NOW) }), { ...RESET, lastPct: 29, lastAt: NOW });
  });

  it(`takes a rise under ${RESET_DROP_PTS} points, however old it may be`, () => {
    const under = RESET_DROP_PTS - 0.5;
    assert.deepEqual(nextPeriod(RESET, { end: END, use: use(under, NOW, END, LONG_BEFORE) }), { ...RESET, lastPct: under, lastAt: NOW });
  });

  it('takes it in a period no reset opened, where the old week drops by its reset time', () => {
    assert.deepEqual(nextPeriod(STORED, { end: END, use: use(84, NOW, END, LONG_BEFORE) }), { ...STORED, lastPct: 84, lastAt: NOW });
  });

  it('still opens a new budget on a fall, however old the reading may be', () => {
    const read: Period = { ...RESET, lastPct: 5 };
    assert.deepEqual(nextPeriod(read, { end: END, use: use(1, NOW, END, LONG_BEFORE) }), { start: read.lastAt, end: END, kind: 'reset', lastPct: 1, lastAt: NOW });
  });
});

describe('nextPeriod, a reset that no stored period saw', () => {
  it(`starts a guess where the metered W reaches the use, when that W is ${LATE_START_RATIO} times the use and ${LATE_START_PTS} points over it`, () => {
    assert.deepEqual(nextPeriod(undefined, { end: END, use: use(55, NOW), metered: SINCE_WEDNESDAY }), INFERRED);
    assert.deepEqual(nextPeriod({ ...STORED, kind: 'assumed' }, { end: END, use: use(55, NOW), metered: SINCE_WEDNESDAY }), INFERRED);
    // A use read at 0 right after the reset: the reading's hour.
    assert.equal(nextPeriod(undefined, { end: END, use: use(0, NOW), metered: SINCE_WEDNESDAY }).start, NOW);
  });

  it('keeps the guess while the metered W is near the use', () => {
    // 70% metered against 55%: under the ratio.
    assert.equal(nextPeriod(undefined, { end: END, use: use(55, NOW), metered: flat(1, NOW - 70 * HOUR, NOW) }).kind, 'assumed');
    // 14% against 5%: over the ratio, under the points.
    assert.equal(nextPeriod(undefined, { end: END, use: use(5, NOW), metered: flat(1, NOW - 14 * HOUR, NOW) }).kind, 'assumed');
  });

  it('keeps an inferred start on later readings and as the end moves, and leaves a known start alone', () => {
    const later = NOW + HOUR;
    const sight = { end: END + HOUR, use: use(56, later, END + HOUR), metered: flat(1, START, later) };
    assert.deepEqual(nextPeriod(INFERRED, sight), { ...INFERRED, end: END + HOUR, lastPct: 56, lastAt: later });
    assert.deepEqual(nextPeriod(STORED, { end: END, use: use(55, NOW), metered: SINCE_WEDNESDAY }), { ...STORED, lastPct: 55, lastAt: NOW });
  });
});

/** A budget with no configured reset. */
const UNSET: Pick<BudgetConfig, 'reset'> = {};

describe('sightOf', () => {
  const configured: Pick<BudgetConfig, 'reset'> = { reset: { weekday: 'wed', timeUtc: '01:00' } };

  it("takes the status line's reset while it is ahead, else the config's, else none", () => {
    assert.deepEqual(sightOf(UNSET, use(55, NOW, END + HOUR), NOW), { end: END + HOUR, use: use(55, NOW, END + HOUR) });
    assert.deepEqual(sightOf(configured, use(99, NOW - WEEK, START), NOW), { end: END, use: use(99, NOW - WEEK, START) });
    assert.deepEqual(sightOf(configured, undefined, NOW), { end: END, use: undefined });
    assert.deepEqual(sightOf(configured, undefined, NOW, SINCE_WEDNESDAY), { end: END, use: undefined, metered: SINCE_WEDNESDAY });
    assert.equal(sightOf(UNSET, undefined, NOW), undefined);
  });
});

describe('the period file', () => {
  const path = '/kit/usage/period.json';

  it('writes the pinned fields of its format: a field added to the file raises PERIOD_FORMAT', () => {
    const written: Readonly<Record<number, readonly string[]>> = { 1: ['end', 'kind', 'lastAt', 'lastPct', 'start', 'v'] };
    assert.deepEqual(fieldPaths(JSON.parse(formatPeriod(STORED))), written[PERIOD_FORMAT]);
  });

  it('reads back what it wrote, and reads a damaged or other-format file as none', () => {
    assert.deepEqual(parsePeriod(formatPeriod(STORED)), STORED);
    assert.deepEqual(parsePeriod(formatPeriod(INFERRED)), INFERRED);
    for (const text of [
      '',
      'nope',
      '{"v":2,"start":1,"end":2,"kind":"week","lastPct":0,"lastAt":1}',
      '{"v":1,"start":2,"end":1,"kind":"week","lastPct":0,"lastAt":1}',
      '{"v":1,"start":1,"end":2,"kind":"later","lastPct":0,"lastAt":1}',
      '{"v":1,"start":1,"end":2,"kind":"week","lastAt":1}',
    ]) {
      assert.equal(parsePeriod(text), undefined, text);
    }
  });

  it('moves the stored period on and writes it only when it changed', async () => {
    const files = new CountingFiles();
    const store = new PeriodStore(files, path);
    const guessed: Period = { ...STORED, kind: 'assumed' };
    assert.deepEqual(await store.advance({ end: END, use: use(55, NOW - HOUR) }), guessed);
    const written = await files.read(path);
    assert.deepEqual(await store.advance({ end: END, use: use(55, NOW - 2 * HOUR) }), guessed);
    assert.equal(files.writes, 1);
    assert.equal(await files.read(path), written);
    assert.deepEqual(await store.read(), guessed);
  });

  it('starts over from a damaged file, and has no period while no reset is known', async () => {
    const files = new MemoryFiles({ [path]: 'damaged' });
    const store = new PeriodStore(files, path);
    assert.equal(await store.periodAt(UNSET, undefined, NOW), undefined);
    assert.equal(await files.read(path), 'damaged');
    assert.deepEqual(await store.periodAt(UNSET, use(55, NOW), NOW), { start: START, end: END, kind: 'assumed', lastPct: 55, lastAt: NOW });
  });

  it('refuses to move on a file a newer teamrig wrote, leaving it as it was', async () => {
    const newer = '{"v":2,"start":1,"end":2,"kind":"week","lastPct":0,"lastAt":1}';
    const files = new MemoryFiles({ [path]: newer });
    const store = new PeriodStore(files, path);
    await assert.rejects(store.periodAt(UNSET, use(55, NOW), NOW), (error: unknown) => error instanceof NewerDataError && error.found === 2 && error.known === PERIOD_FORMAT);
    assert.equal(await files.read(path), newer);
  });

  it('infers the start from the metered W it is given, and stores it', async () => {
    const store = new PeriodStore(new MemoryFiles(), path);
    assert.deepEqual(await store.periodAt(UNSET, use(55, NOW), NOW, SINCE_WEDNESDAY), INFERRED);
    assert.deepEqual(await store.read(), INFERRED);
  });

  it('gives the stored period it moved on from beside the period after', async () => {
    const store = new PeriodStore(new MemoryFiles(), path);
    assert.equal(await store.moveAt(UNSET, undefined, NOW), undefined);
    const first = await store.moveAt(UNSET, use(55, NOW - HOUR), NOW);
    assert.deepEqual(first, { before: undefined, period: { start: START, end: END, kind: 'assumed', lastPct: 55, lastAt: NOW - HOUR } });
    const next = await store.moveAt(UNSET, use(57, NOW), NOW);
    assert.deepEqual(next, { before: first?.period, period: { start: START, end: END, kind: 'assumed', lastPct: 57, lastAt: NOW } });
  });

  it('peeks at the period a move would give and leaves the file as it was (T2028)', async () => {
    const files = new CountingFiles({ [path]: formatPeriod(STORED) });
    const store = new PeriodStore(files, path);
    assert.deepEqual(await store.peekAt(UNSET, use(57, NOW), NOW), { ...STORED, lastPct: 57, lastAt: NOW });
    assert.deepEqual(await store.peekAt(UNSET, use(50, NOW), NOW), { start: NOW - HOUR, end: END, kind: 'reset', lastPct: 50, lastAt: NOW });
    assert.equal(await store.peekAt(UNSET, undefined, NOW), undefined);
    assert.equal(files.writes, 0);
    assert.deepEqual(await store.read(), STORED);
  });

  it('refuses to peek at a file a newer teamrig wrote, as a move does', async () => {
    const store = new PeriodStore(new MemoryFiles({ [path]: '{"v":2,"start":1,"end":2,"kind":"week","lastPct":0,"lastAt":1}' }), path);
    await assert.rejects(store.peekAt(UNSET, use(55, NOW), NOW), (error: unknown) => error instanceof NewerDataError && error.found === 2);
  });
});
