import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET } from '../config/defaults.ts';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_WEEK } from '../core/time.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { calibrationOf, MeterLog, type MeterReading } from './calibration.ts';
import { emptyPatterns } from './patterns.ts';
import { formatPeriod, parsePeriod, type Period } from './period.ts';
import type { WeekUse } from './snapshot.ts';
import type { UsageState } from './store.ts';
import { teamWeekOf } from './team-week.ts';
import { readWeek } from './week.ts';

const PATHS = { period: '/team/state/usage/period.json', meterLog: '/team/state/usage/meter-log.jsonl' };
/** Thursday 2026-10-15 12:00 UTC; the week runs from Wednesday 10-14 01:00 to Wednesday 10-21 01:00. */
const NOW = Date.parse('2026-10-15T12:00:00Z');
const END = Date.parse('2026-10-21T01:00:00Z');
const START = Date.parse('2026-10-14T01:00:00Z');
const STATUS: WeekUse = { usedPct: 20, resetsAt: END, at: NOW - 60_000 };
const NOTHING_LEARNED = calibrationOf([]);

function state(wByDay: Readonly<Record<string, number>>): UsageState {
  const byDay = Object.fromEntries(Object.entries(wByDay).map(([day, w]) => [day, { w, calls: 1, patterns: emptyPatterns() }]));
  return { byDay, byHour: {}, byTask: {}, cursors: {}, recentKeys: [] };
}

/** Stores reaching back to the week's first day: 1,000 W since its start. */
const STATES = [state({ '2026-10-14': 600, '2026-10-15': 400 })];

/** The week's period as stored an hour ago, at `lastPct`. */
async function storedAt(files: MemoryFiles, lastPct: number): Promise<Period> {
  const stored: Period = { start: START, end: END, kind: 'week', lastPct, lastAt: NOW - MS_PER_HOUR };
  await files.write(PATHS.period, formatPeriod(stored));
  return stored;
}

describe('teamWeekOf', () => {
  it('moves the stored period on to the status line, reads the week in it and logs the percents it passed', async () => {
    const files = new MemoryFiles();
    const stored = await storedAt(files, 15);
    const week = await teamWeekOf(files, PATHS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: STATES });
    const moved = parsePeriod((await files.read(PATHS.period)) ?? '');
    assert.deepEqual(moved, { ...stored, lastPct: 20, lastAt: STATUS.at });
    assert.deepEqual(week, readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: stored, states: STATES, calibration: NOTHING_LEARNED }));
    const logged: MeterReading = { at: STATUS.at, usedPct: 20, start: START, end: END, w: 1_000, forecastPct: undefined };
    assert.deepEqual(await new MeterLog(files, PATHS.meterLog).read(NOW), [logged]);
  });

  it('logs nothing while the status line stays within the percent last read', async () => {
    const files = new MemoryFiles();
    await storedAt(files, 20);
    await teamWeekOf(files, PATHS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: STATES });
    assert.equal(await files.read(PATHS.meterLog), undefined);
  });

  it("takes the meter log's fit as the week's rate and logs its forecast with the next reading", async () => {
    const files = new MemoryFiles();
    const log = new MeterLog(files, PATHS.meterLog);
    const last = { start: START - MS_PER_WEEK, end: START, forecastPct: undefined };
    // 100 W per percent: 500 W at 5% and 1,600 W at 16%, 11 points apart.
    await log.append({ ...last, at: START - 6 * MS_PER_DAY, usedPct: 5, w: 500 }, NOW);
    await log.append({ ...last, at: START - 2 * MS_PER_DAY, usedPct: 16, w: 1_600 }, NOW);
    await storedAt(files, 15);
    const week = await teamWeekOf(files, PATHS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: STATES });
    assert.deepEqual([week.wPerPct, week.rateFrom, week.calibration.fit?.readings], [100, 'learned', 2]);
    assert.equal((await log.read(NOW)).at(-1)?.forecastPct, 10);
  });

  it('reads the week without a period while no reset is known, and writes none', async () => {
    // The default budget sets no reset, and with no status line nothing shows one.
    const files = new MemoryFiles();
    const week = await teamWeekOf(files, PATHS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: undefined, states: STATES });
    assert.deepEqual([await files.read(PATHS.period), await files.read(PATHS.meterLog)], [undefined, undefined]);
    assert.deepEqual(week, readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: undefined, period: undefined, states: STATES, calibration: NOTHING_LEARNED }));
  });
});
