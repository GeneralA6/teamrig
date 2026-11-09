import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NewerDataError, toJsonlLine } from '../core/jsonl.ts';
import { MS_PER_HOUR, MS_PER_WEEK } from '../core/time.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { MeterReading } from './calibration.ts';
import {
  EXTRA_LOG_FORMAT,
  ExtraLog,
  extraRecordOf,
  fitWPerUsd,
  FULL_PCT,
  limitSpansOf,
  parseExtraRecord,
  pastLimitOf,
  poolOf,
  spentUsdOf,
  type ExtraEntry,
  type ExtraPool,
  wAtFullOf,
  type PoolSight,
} from './extra.ts';

const LOG = '/team/state/usage/extra-log.jsonl';
/** The week from Wednesday 10-21 01:00 to Wednesday 10-28 01:00; it read 100% on Monday 10-26 at 09:00 UTC, 900M W in. */
const START = Date.parse('2026-10-21T01:00:00Z');
const END = Date.parse('2026-10-28T01:00:00Z');
const FULL_AT = Date.parse('2026-10-26T09:00:00Z');
const W_AT_FULL = 900_000_000;
/** The spent readings below price the pool at 2M W per dollar. */
const W_PER_USD = 2_000_000;

function entry(fields: Partial<ExtraEntry> & Pick<ExtraEntry, 'kind' | 'usd'>): ExtraEntry {
  return { at: FULL_AT, weekPct: FULL_PCT, start: START, end: END, w: W_AT_FULL, ...fields };
}

/** A spent reading `hours` after the 100% crossing, `usd` spent so far and `wPast` W metered past 100%. */
function spent(usd: number, hours: number, wPast: number, weekPct: number = FULL_PCT): ExtraEntry {
  return entry({ kind: 'spent', usd, at: FULL_AT + hours * MS_PER_HOUR, w: W_AT_FULL + wPast, weekPct });
}

const ADD = entry({ kind: 'add', usd: 50, at: FULL_AT - MS_PER_HOUR, weekPct: 99 });
/** Now: 100% read, 30M W metered past the crossing. */
const SIGHT: PoolSight = { start: START, w: W_AT_FULL + 30_000_000, usedPct: FULL_PCT, wAtFull: W_AT_FULL, configuredWPerUsd: undefined };

describe('fitWPerUsd', () => {
  it('fits W per dollar through 0 over successive spent readings past 100%, in time order', () => {
    const readings = [spent(25, 3, 50_000_000), spent(0, 0, 0), spent(10, 1, 20_000_000)];
    assert.deepEqual(fitWPerUsd(readings), { wPerUsd: W_PER_USD, pairs: 2 });
  });

  it('fits by least squares when the pairs disagree', () => {
    const fit = fitWPerUsd([spent(0, 0, 0), spent(10, 1, 10_000_000), spent(20, 2, 40_000_000)]);
    assert.deepEqual(fit, { wPerUsd: (10 * 10_000_000 + 10 * 30_000_000) / 200, pairs: 2 });
  });

  it('pairs only spent readings of one period, both at or past 100%, with dollars spent between them', () => {
    const lastWeek = { start: START - MS_PER_WEEK, end: START };
    assert.equal(fitWPerUsd([spent(0, 0, 0, 99), spent(10, 1, 20_000_000)]), undefined);
    assert.equal(fitWPerUsd([entry({ ...lastWeek, kind: 'spent', usd: 0 }), spent(10, 1, 20_000_000)]), undefined);
    assert.equal(fitWPerUsd([spent(10, 0, 0), spent(10, 1, 20_000_000)]), undefined);
    assert.equal(fitWPerUsd([ADD, entry({ kind: 'add', usd: 10, w: W_AT_FULL + 20_000_000 }), spent(0, 2, 0)]), undefined);
  });
});

describe('poolOf', () => {
  it('is nothing while no dollars were added', () => {
    assert.equal(poolOf([spent(0, 0, 0)], SIGHT), undefined);
  });

  it('counts the W metered past 100% since the last spent reading at the learned rate', () => {
    const pool = poolOf([ADD, spent(0, 0, 0), spent(10, 1, 20_000_000)], SIGHT);
    assert.deepEqual(pool, { addedUsd: 50, spentUsd: 15, leftUsd: 35, wPerUsd: W_PER_USD, learned: true, leftW: 35 * W_PER_USD });
  });

  it("counts from the period's 100% crossing at the configured rate before any spent reading of the period", () => {
    const lastWeek = entry({ kind: 'spent', usd: 5, start: START - MS_PER_WEEK, end: START, at: START - MS_PER_HOUR });
    const pool = poolOf([ADD, lastWeek], { ...SIGHT, configuredWPerUsd: W_PER_USD });
    assert.deepEqual(pool, { addedUsd: 50, spentUsd: 20, leftUsd: 30, wPerUsd: W_PER_USD, learned: false, leftW: 30 * W_PER_USD });
  });

  it('lets the last reading stand below 100%, without a rate, or with neither a reading of the period nor a crossing', () => {
    const readings = [ADD, spent(0, 0, 0), spent(10, 1, 20_000_000)];
    assert.equal(poolOf(readings, { ...SIGHT, usedPct: 99 })?.spentUsd, 10);
    assert.deepEqual(poolOf([ADD, spent(10, 1, 20_000_000)], SIGHT), {
      addedUsd: 50,
      spentUsd: 10,
      leftUsd: 40,
      wPerUsd: undefined,
      learned: false,
      leftW: undefined,
    });
    assert.equal(poolOf([ADD], { ...SIGHT, wAtFull: undefined, configuredWPerUsd: W_PER_USD })?.spentUsd, 0);
  });

  it('never leaves less than nothing in the pool', () => {
    assert.equal(poolOf([ADD, spent(0, 0, 0), spent(60, 1, 120_000_000)], SIGHT)?.leftUsd, 0);
  });

  it("keeps the dollars spent before claude.ai's monthly counter restarts, a reading below the one before starting a new count (T997)", () => {
    const restarted = [ADD, spent(30, 0, 0, 99), spent(4, 1, 8_000_000, 99)];
    assert.deepEqual(poolOf(restarted, { ...SIGHT, usedPct: 99 }), {
      addedUsd: 50,
      spentUsd: 34,
      leftUsd: 16,
      wPerUsd: undefined,
      learned: false,
      leftW: undefined,
    });
  });
});

describe('spentUsdOf', () => {
  it("is the last reading while claude.ai's counter only rises, and nothing with no reading", () => {
    assert.equal(spentUsdOf([]), 0);
    assert.equal(spentUsdOf([spent(0, 0, 0), spent(10, 1, 0), spent(10, 2, 0), spent(25, 3, 0)]), 25);
  });

  it("adds each count's last reading once the counter restarts, as often as it does", () => {
    assert.equal(spentUsdOf([spent(12, 0, 0), spent(30, 1, 0), spent(0, 2, 0), spent(8, 3, 0), spent(3, 4, 0), spent(5, 5, 0)]), 30 + 8 + 5);
  });
});

describe('pastLimitOf', () => {
  /** $35 of $50 left at 2M W per dollar. */
  const POOL: ExtraPool = { addedUsd: 50, spentUsd: 15, leftUsd: 35, wPerUsd: W_PER_USD, learned: false, leftW: 70_000_000 };

  it("is unset below 100% of the week, where the week's remainder sets the allowance", () => {
    assert.equal(pastLimitOf(99.9, POOL), undefined);
  });

  it('names the pool while it holds W, else why nothing sets the allowance past 100%', () => {
    const dollarsOnly: ExtraPool = { ...POOL, wPerUsd: undefined, leftW: undefined };
    const spentOut: ExtraPool = { ...POOL, spentUsd: 50, leftUsd: 0, leftW: 0 };
    const pools = [POOL, dollarsOnly, spentOut, { ...dollarsOnly, spentUsd: 50, leftUsd: 0 }, undefined];
    assert.deepEqual(
      pools.map((pool) => pastLimitOf(FULL_PCT, pool)),
      ['pool', 'unpriced', 'empty', 'empty', 'empty'],
    );
  });
});

describe('wAtFullOf', () => {
  function line(start: number, usedPct: number, w: number): MeterReading {
    return { at: FULL_AT, usedPct, start, end: start + MS_PER_WEEK, w, forecastPct: undefined };
  }

  it("takes the W of the period's first meter line at 100% of the week", () => {
    const readings = [line(START - MS_PER_WEEK, FULL_PCT, 800_000_000), line(START, 99, 890_000_000), line(START, FULL_PCT, W_AT_FULL)];
    assert.equal(wAtFullOf(readings, START), W_AT_FULL);
  });

  it('is unknown before the period reached 100%, whatever an earlier period reached', () => {
    assert.equal(wAtFullOf([line(START - MS_PER_WEEK, FULL_PCT, 800_000_000), line(START, 99, 890_000_000)], START), undefined);
  });
});

describe('limitSpansOf', () => {
  /** A meter line of the period starting at `start`, a week long unless `end` says otherwise. */
  function line(at: number, usedPct: number, start: number, end: number = start + MS_PER_WEEK): MeterReading {
    return { at, usedPct, start, end, w: 0, forecastPct: undefined };
  }

  it("spans each period from its earliest line at 100%, any team's, to the period's end, oldest first", () => {
    const lastFull = START - 2 * MS_PER_HOUR;
    const readings = [line(FULL_AT + MS_PER_HOUR, 101, START), line(FULL_AT, FULL_PCT, START), line(lastFull, FULL_PCT, START - MS_PER_WEEK), line(FULL_AT - MS_PER_HOUR, 99, START)];
    assert.deepEqual(limitSpansOf(readings), [
      { start: lastFull, end: START },
      { start: FULL_AT, end: END },
    ]);
  });

  it('ends a stretch where the next period began sooner, and gives none for a period below 100%', () => {
    const reset = FULL_AT + 6 * MS_PER_HOUR;
    assert.deepEqual(limitSpansOf([line(FULL_AT, FULL_PCT, START, END), line(reset + MS_PER_HOUR, 5, reset)]), [{ start: FULL_AT, end: reset }]);
    assert.deepEqual(limitSpansOf([line(FULL_AT, 99, START)]), []);
  });
});

describe('extra log records', () => {
  it('round-trips an entry, with and without the week use', () => {
    for (const kept of [ADD, entry({ kind: 'spent', usd: 0, weekPct: undefined })]) {
      assert.deepEqual(parseExtraRecord(extraRecordOf(kept)), kept);
    }
  });

  it('reads a damaged record as nothing', () => {
    const record = extraRecordOf(ADD);
    for (const damaged of [
      { ...record, kind: 'refund' },
      { ...record, usd: -1 },
      { ...record, usd: 0 },
      extraRecordOf(entry({ kind: 'add', usd: 50, start: END })),
      { ...record, weekPct: 'full' },
      { ...record, w: -1 },
      { ...record, at: 'later' },
    ]) {
      assert.equal(parseExtraRecord(damaged), undefined);
    }
  });
});

describe('ExtraLog', () => {
  it('appends entries and reads them back, oldest first', async () => {
    const log = new ExtraLog(new MemoryFiles(), LOG);
    await log.append(ADD);
    await log.append(spent(0, 0, 0));
    assert.deepEqual(await log.read(), [ADD, spent(0, 0, 0)]);
  });

  it('skips damaged lines and lines from a newer teamrig', async () => {
    const files = new MemoryFiles({ [LOG]: `${toJsonlLine(extraRecordOf(ADD))}not json\n${toJsonlLine({ ...extraRecordOf(ADD), v: EXTRA_LOG_FORMAT + 1 })}` });
    assert.deepEqual(await new ExtraLog(files, LOG).read(), [ADD]);
  });

  it('refuses to append beside a line from a newer teamrig', async () => {
    const files = new MemoryFiles({ [LOG]: toJsonlLine({ ...extraRecordOf(ADD), v: EXTRA_LOG_FORMAT + 1 }) });
    await assert.rejects(new ExtraLog(files, LOG).append(ADD), NewerDataError);
  });

  it('ends a torn last line before appending', async () => {
    const files = new MemoryFiles({ [LOG]: '{"v":1,"at":' });
    const log = new ExtraLog(files, LOG);
    await log.append(ADD);
    assert.deepEqual(await log.read(), [ADD]);
  });
});
