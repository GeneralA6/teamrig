import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET } from '../config/defaults.ts';
import type { BudgetConfig } from '../config/types.ts';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_WEEK } from '../core/time.ts';
import { DailyProfile } from './active-time.ts';
import { emptyPatterns } from './patterns.ts';
import type { Period } from './period.ts';
import type { WeekUse } from './snapshot.ts';
import type { UsageState } from './store.ts';
import { calibrationOf, type Calibration, type MeterReading } from './calibration.ts';
import type { ExtraEntry } from './extra.ts';
import {
  coversFrom,
  FORECAST_SPAN_MS,
  idleWSince,
  limitWPerPct,
  meteredOf,
  rateOf,
  readWeek,
  TODAY_RATE_MAX_RATIO,
  TODAY_RATE_SPAN_PTS,
  wSince,
  type WeekInput,
  type WeekReading,
} from './week.ts';

/** Thursday 2026-10-15 12:00 UTC; the week runs from Wednesday 10-14 01:00 to Wednesday 10-21 01:00. */
const NOW = Date.parse('2026-10-15T12:00:00Z');
const RESET = Date.parse('2026-10-21T01:00:00Z');
const STATUS: WeekUse = { usedPct: 57, resetsAt: RESET, at: Date.parse('2026-10-15T11:00:00Z') };
/** The period of that week. */
const PERIOD: Pick<Period, 'start' | 'end' | 'kind'> = { start: Date.parse('2026-10-14T01:00:00Z'), end: RESET, kind: 'week' };
/** An empty meter log: nothing learned. */
const NONE: Calibration = calibrationOf([]);
/** A meter log whose fit puts 1% of the week at 20 W. */
const LEARNED: Calibration = { fit: { wPerPct: 20, errorPts: 0.4, readings: 12 }, periods: [] };
/** The status line at 100% of the week. */
const FULL: WeekUse = { ...STATUS, usedPct: 100 };
/** $10 added to the extra-usage pool at 10:00, the week at 100% and 1,400 W metered. */
const ADDED: ExtraEntry = { at: Date.parse('2026-10-15T10:00:00Z'), kind: 'add', usd: 10, weekPct: 100, start: PERIOD.start, end: RESET, w: 1_400 };

function state(wByDay: Readonly<Record<string, number>>): UsageState {
  const byDay = Object.fromEntries(Object.entries(wByDay).map(([day, w]) => [day, { w, calls: 1, patterns: emptyPatterns() }]));
  return { byDay, byHour: {}, byTask: {}, cursors: {}, recentKeys: [] };
}

/** Two sessions' stores reaching back to the week's first day: 1,000 W that day, 500 W today. */
const COVERED = [state({ '2026-10-14': 600, '2026-10-15': 300 }), state({ '2026-10-14': 400, '2026-10-15': 200, '2026-10-13': 9_999 })];

/** A meter log reading of this week (or the period from `start`): its use and the W metered since the start. */
function meterReading(usedPct: number, w: number, start: number = PERIOD.start): MeterReading {
  return { at: NOW, usedPct, start, end: RESET, w, forecastPct: undefined };
}

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 1000) / 1000;
}

describe('readWeek', () => {
  it('knows nothing but today\'s W without a status line, a limit or a reset', () => {
    const week = readWeek({ readings: [], calibration: NONE, budget: DEFAULT_BUDGET, now: NOW, statusUse: undefined, period: undefined, states: COVERED });
    assert.deepEqual(week, {
      reset: undefined,
      window: undefined,
      periodKind: undefined,
      usedPct: undefined,
      statusAt: undefined,
      wPerPct: undefined,
      rateFrom: undefined,
      calibration: NONE,
      covered: false,
      pace: undefined,
      allowancePct: undefined,
      plannedPct: undefined,
      todayFrom: Date.parse('2026-10-15T00:00:00Z'),
      todayW: 500,
      todayWPerPct: undefined,
      teamDay: undefined,
      pool: undefined,
      forecast: undefined,
    });
  });

  it('takes the use and reset from the status line and estimates the limit once the week is metered whole', () => {
    const week = readWeek({ readings: [], calibration: NONE, budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: PERIOD, states: COVERED });
    assert.deepEqual([week.reset, week.usedPct, week.statusAt, week.covered, week.rateFrom], [RESET, 57, STATUS.at, true, 'estimate']);
    assert.equal(round(week.wPerPct), round(1_500 / 57));
    assert.equal(round(week.pace?.linePct), round((99.5 * 35) / 167));
    assert.equal(week.pace?.state, 'ahead');
    // 57% now: the 42.5% left over the 132 hours to the pace end, a 24-hour day of it.
    assert.equal(round(week.allowancePct), round((42.5 * 24) / 132));
    // The pace line plans 24 of its 167 hours for the day: ahead of it, the allowance is below that, a short day.
    assert.equal(round(week.plannedPct), round((99.5 * 24) / 167));
  });

  it('plans nothing for the day once the pace end is past', () => {
    const late = readWeek({ readings: [], calibration: NONE, budget: DEFAULT_BUDGET, now: Date.parse('2026-10-21T00:30:00Z'), statusUse: undefined, period: PERIOD, states: COVERED });
    assert.equal(late.plannedPct, 0);
  });

  it("counts the week from its reset's hour: the use before it that day is the last week's", () => {
    const resetDay = Date.parse('2026-10-14T12:00:00Z');
    const lastReset = Date.parse('2026-10-14T01:00:00Z');
    const status: WeekUse = { usedPct: 2, resetsAt: RESET, at: resetDay };
    const hours = { ...state({ '2026-10-13': 5_000, '2026-10-14': 1_000 }), byHour: { '2026-10-14T00': 600, '2026-10-14T05': 400 } };
    const week = readWeek({ readings: [], calibration: NONE, budget: DEFAULT_BUDGET, now: resetDay, statusUse: status, period: PERIOD, states: [hours] });
    assert.deepEqual([week.window?.start, week.todayFrom], [lastReset, lastReset]);
    assert.deepEqual([week.todayW, week.wPerPct, week.teamDay?.usedPct], [400, 200, 2]);
    assert.equal(round(week.plannedPct), round((99.5 * 23) / 167), "the day's 23 hours inside the week");
  });

  it("counts a store whose hours were lost with its whole first day, as before hours were kept", () => {
    const resetDay = Date.parse('2026-10-14T12:00:00Z');
    const status: WeekUse = { usedPct: 2, resetsAt: RESET, at: resetDay };
    const week = readWeek({ readings: [], calibration: NONE, budget: DEFAULT_BUDGET, now: resetDay, statusUse: status, period: PERIOD, states: [state({ '2026-10-13': 5_000, '2026-10-14': 1_000 })] });
    assert.deepEqual([week.todayW, week.wPerPct], [1_000, 500]);
  });

  it("counts a new budget from a reset inside the week: its pace line and today's use start there", () => {
    const reset = Date.parse('2026-10-15T10:00:00Z');
    const status: WeekUse = { usedPct: 1, resetsAt: RESET, at: NOW };
    const hours = { ...state({ '2026-10-14': 1_000, '2026-10-15': 300 }), byHour: { '2026-10-15T09': 200, '2026-10-15T10': 100 } };
    const week = readWeek({ readings: [], calibration: NONE, budget: DEFAULT_BUDGET, now: NOW, statusUse: status, period: { start: reset, end: RESET, kind: 'reset' }, states: [hours] });
    assert.deepEqual([week.window?.start, week.periodKind, week.todayFrom, week.todayW, week.wPerPct, week.covered], [reset, 'reset', reset, 100, 100, true]);
    // 2 of the 134 hours from the reset to the pace end, an hour before the week's.
    assert.equal(round(week.pace?.linePct), round((99.5 * 2) / 134));
    assert.equal(round(week.plannedPct), round((99.5 * 14) / 134), "the day's 14 hours from the reset");
  });

  it('has no limit estimate while the stores start after the week did', () => {
    const late = [state({ '2026-10-15': 500 })];
    const week = readWeek({ readings: [], calibration: NONE, budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: PERIOD, states: late });
    assert.deepEqual([week.usedPct, week.covered, week.wPerPct, week.allowancePct, week.rateFrom], [57, false, undefined, undefined, undefined]);
  });

  it('meters the use from budget.weeklyLimitW when there is no status line', () => {
    const budget: BudgetConfig = { ...DEFAULT_BUDGET, weeklyLimitW: 100_000 };
    const week = readWeek({ readings: [], calibration: NONE, budget, now: NOW, statusUse: undefined, period: PERIOD, states: COVERED });
    assert.deepEqual([week.reset, week.wPerPct, week.usedPct, week.statusAt, week.rateFrom], [RESET, 1_000, 1.5, undefined, 'limit']);
    assert.equal(week.pace?.state, 'behind');
    assert.equal(round(week.allowancePct), round((98 * 24) / 132));
  });

  it("takes the meter log's learned rate over budget.weeklyLimitW and the status line's estimate", () => {
    const budget: BudgetConfig = { ...DEFAULT_BUDGET, weeklyLimitW: 100_000 };
    const week = readWeek({ readings: [], calibration: LEARNED, budget, now: NOW, statusUse: STATUS, period: PERIOD, states: COVERED });
    // The status line still gives the use; today's 500 W are 25% of the week at 20 W per percent.
    assert.deepEqual([week.wPerPct, week.rateFrom, week.usedPct, week.teamDay?.usedPct, week.calibration], [20, 'learned', 57, 25, LEARNED]);
    const metered = readWeek({ readings: [], calibration: LEARNED, budget, now: NOW, statusUse: undefined, period: PERIOD, states: COVERED });
    assert.deepEqual([metered.wPerPct, metered.usedPct], [20, 75]);
  });

  it("reads today's use from the status line between the meter log's readings, not at the week's rate", () => {
    // 1,000 W at today's start sit between 40% at 900 W and 45% at 1,100 W: 42.5%. The 1,500 W now are 20 W past
    // 57% at 1,480 W: 58% at 20 W per percent. Today is 15.5 points, where its 500 W at the week's rate read 25.
    const readings = [meterReading(40, 900), meterReading(45, 1_100), meterReading(57, 1_480)];
    const week = readWeek({ readings, calibration: LEARNED, budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: PERIOD, states: COVERED });
    assert.deepEqual([week.wPerPct, round(week.teamDay?.usedPct), round(week.todayWPerPct)], [20, 15.5, round(500 / 15.5)]);
  });

  it("holds the use now to the status line's percent: at least it, and below the next while its reading is fresh", () => {
    const fresh: WeekUse = { ...STATUS, at: Date.parse('2026-10-15T11:59:00Z') };
    const today = (statusUse: WeekUse, lastPct: number, lastW: number): number | undefined => {
      const readings = [meterReading(40, 900), meterReading(45, 1_100), meterReading(lastPct, lastW)];
      return round(readWeek({ readings, calibration: LEARNED, budget: DEFAULT_BUDGET, now: NOW, statusUse, period: PERIOD, states: COVERED }).teamDay?.usedPct);
    };
    // 60 W past 57% at 1,440 W read 60%: held below 58% by a fresh 57%, not by the hour-old one; from 42.5% either way.
    assert.deepEqual([today(fresh, 57, 1_440), today(STATUS, 57, 1_440)], [15.5, 17.5]);
    // 100 W past 50% at 1,400 W read 55%, below the status line's 57%.
    assert.equal(today(STATUS, 50, 1_400), 14.5);
    // At 100% the status line stops while the use goes on into the extra-usage pool: 105%, not held below 101%.
    assert.equal(today({ ...FULL, at: fresh.at }, 100, 1_400), 62.5);
  });

  it(`prices the day's W at today's own rate once today spans ${TODAY_RATE_SPAN_PTS} points, else at the week's`, () => {
    const budget: BudgetConfig = { ...DEFAULT_BUDGET, quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' } };
    const night = { ...state({ '2026-10-14': 1_000, '2026-10-15': 500 }), byHour: { '2026-10-15T02': 300, '2026-10-15T09': 200 } };
    const readings = [meterReading(40, 900), meterReading(45, 1_100), meterReading(57, 1_480)];
    const week = readWeek({ readings, calibration: LEARNED, budget, now: NOW, statusUse: STATUS, period: PERIOD, states: [night] });
    // The 300 W of 02:00 are 300 / (500 / 15.5) % of the week at today's rate, paced as spent.
    assert.equal(round(week.teamDay?.pacePct), round((300 * 15.5) / 500 + (((42.5 * 16) / 90) * 6) / 16));
    // 30 W today from 50% at 1,000 W: 1.5 points, priced at the week's 20 W per percent.
    const quiet = readWeek({
      readings: [meterReading(50, 1_000)],
      calibration: LEARNED,
      budget: DEFAULT_BUDGET,
      now: NOW,
      statusUse: { ...STATUS, usedPct: 51 },
      period: PERIOD,
      states: [state({ '2026-10-14': 1_000, '2026-10-15': 30 })],
    });
    assert.deepEqual([round(quiet.teamDay?.usedPct), quiet.todayWPerPct], [1.5, 20]);
  });

  it(`prices the day's W at the week's rate when today's own strays past ${TODAY_RATE_MAX_RATIO} times it, either way`, () => {
    const priced = (readings: readonly MeterReading[]): readonly [number | undefined, number | undefined] => {
      const week = readWeek({ readings, calibration: LEARNED, budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: PERIOD, states: COVERED });
      return [round(week.teamDay?.usedPct), week.todayWPerPct];
    };
    // Today's 500 W read from 55% at 1,000 W to 58%: 3 points, 167 W per percent against the week's 20.
    assert.deepEqual(priced([meterReading(55, 1_000), meterReading(57, 1_480)]), [3, 20]);
    // From 5% at 1,000 W to 58%: 53 points, 9.4 W per percent.
    assert.deepEqual(priced([meterReading(5, 1_000), meterReading(57, 1_480)]), [53, 20]);
  });

  it('prices the day at the new limit once the period it moved in spans the fit, not the old one (T1985)', () => {
    const lastWeek = PERIOD.start - MS_PER_WEEK;
    const atOldLimit = [10, 50, 90].map((pct) => meterReading(pct, pct * 100, lastWeek));
    const readings = [...atOldLimit, meterReading(19, 500), meterReading(38, 1_000), meterReading(57, 1_500)];
    const week = readWeek({ readings, calibration: calibrationOf(readings), budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: PERIOD, states: COVERED });
    assert.deepEqual([round(week.wPerPct), round(week.todayWPerPct)], [round(500 / 19), round(500 / 19)]);
  });

  it("counts today's W at the week's rate while the period has no reading or the stores miss its start", () => {
    const older = meterReading(40, 900, PERIOD.start - MS_PER_WEEK);
    const unread = readWeek({ readings: [older], calibration: LEARNED, budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: PERIOD, states: COVERED });
    const readings = [meterReading(40, 900), meterReading(57, 1_480)];
    const late = readWeek({ readings, calibration: LEARNED, budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: PERIOD, states: [state({ '2026-10-15': 500 })] });
    assert.deepEqual([unread, late].map((week) => [week.teamDay?.usedPct, week.todayWPerPct]), [[25, 20], [25, 20]]);
  });

  describe(`the run-out forecast, at the status line's rise over the last ${FORECAST_SPAN_MS / MS_PER_HOUR} hours`, () => {
    /** Stores whose last day, from Wednesday 12:00, holds 1,100 W of the week's 1,500: 400 W came before it. */
    const DAY_HOURS = [{ ...state({ '2026-10-14': 1_000, '2026-10-15': 500 }), byHour: { '2026-10-14T05': 400, '2026-10-14T12': 600 } }];
    const forecastWeek = (readings: readonly MeterReading[], change: Partial<WeekInput> = {}): WeekReading =>
      readWeek({ readings, calibration: LEARNED, budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: PERIOD, states: DAY_HOURS, ...change });

    it('says when the week reaches 100% at that rise, before the reset', () => {
      // 400 W sit between 20% at 300 W and 25% at 500 W: 22.5%. The 1,500 W now are 58%: 35.5 points in the day.
      const week = forecastWeek([meterReading(20, 300), meterReading(25, 500), meterReading(57, 1_480)]);
      assert.equal(week.forecast?.risePts, 35.5);
      assert.equal(round(week.forecast?.endPct), round(58 + (35.5 * 133) / 24), 'the reset is 133 hours away');
      assert.equal(week.forecast?.fullAt, NOW + (42 / 35.5) * MS_PER_DAY);
    });

    it('says where the week ends when that rise keeps it below 100%', () => {
      // From 55% at 400 W to 58%: 3 points in the day.
      const week = forecastWeek([meterReading(55, 400), meterReading(57, 1_480)]);
      assert.deepEqual([week.forecast?.risePts, round(week.forecast?.endPct), week.forecast?.fullAt], [3, round(58 + (3 * 133) / 24), undefined]);
    });

    it("has none in the period's first day, at the reset, at 100%, without the period's readings or stores reaching its start", () => {
      const readings = [meterReading(20, 300), meterReading(57, 1_480)];
      const firstDay = Date.parse('2026-10-14T13:00:00Z');
      const weeks = [
        forecastWeek(readings, { now: firstDay, statusUse: { ...STATUS, usedPct: 10, at: firstDay } }),
        forecastWeek(readings, { now: RESET }),
        forecastWeek(readings, { statusUse: FULL }),
        forecastWeek([]),
        forecastWeek(readings, { states: [state({ '2026-10-15': 500 })] }),
      ];
      assert.deepEqual(weeks.map((week) => week.forecast), [undefined, undefined, undefined, undefined, undefined]);
    });
  });

  it('paces by the active time of budget.quietHours', () => {
    const budget: BudgetConfig = { ...DEFAULT_BUDGET, quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' } };
    const week = readWeek({ readings: [], calibration: NONE, budget, now: NOW, statusUse: STATUS, period: PERIOD, states: COVERED });
    // Wed 01:00 to Thu 12:00 is 16 + 6 of the week's 112 active hours; 42.5% left over the other 90, a 16-hour day of it.
    assert.equal(round(week.pace?.linePct), round((99.5 * 22) / 112));
    assert.equal(round(week.allowancePct), round((42.5 * 16) / 90));
    // Thursday 12:00 is 6 of the day's 16 active hours, and today's 500 W are 500 / (1,500 / 57) % of the week.
    assert.equal(round(week.teamDay?.pacePct), round((((42.5 * 16) / 90) * 6) / 16));
    assert.equal(round(week.teamDay?.usedPct), round((500 * 57) / 1_500));
  });

  it("paces today's use in quiet hours as spent: the in-day pace starts from it", () => {
    const budget: BudgetConfig = { ...DEFAULT_BUDGET, quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' } };
    const night = { ...state({ '2026-10-14': 1_000, '2026-10-15': 500 }), byHour: { '2026-10-15T02': 300, '2026-10-15T09': 200 } };
    const week = readWeek({ readings: [], calibration: NONE, budget, now: NOW, statusUse: STATUS, period: PERIOD, states: [night] });
    // The 300 W of 02:00 are 300 / (1,500 / 57) % of the week; the 200 W of 09:00 are paced by the active time.
    assert.equal(round(week.teamDay?.pacePct), round((300 * 57) / 1_500 + (((42.5 * 16) / 90) * 6) / 16));
    assert.equal(round(week.teamDay?.usedPct), round((500 * 57) / 1_500));
  });

  it("has no allowance while the week's use cannot be read: no fixed number stands in for it", () => {
    const unknown = readWeek({ readings: [], calibration: NONE, budget: DEFAULT_BUDGET, now: NOW, statusUse: undefined, period: PERIOD, states: [] });
    assert.deepEqual([unknown.allowancePct, unknown.teamDay], [undefined, undefined]);
  });

  it('spreads the W left in the extra-usage pool past 100% of the week over the time to the pace end', () => {
    const budget: BudgetConfig = { ...DEFAULT_BUDGET, extraWPerUsd: 100 };
    const week = readWeek({ readings: [], calibration: LEARNED, budget, now: NOW, statusUse: FULL, period: PERIOD, states: COVERED, extra: { entries: [ADDED], wAtFull: 1_400 } });
    // 100 W metered past the 100% line at 100 W per dollar: $1 of the $10 spent, 900 W left, 45% of the week at 20 W per percent.
    assert.deepEqual(week.pool, { addedUsd: 10, spentUsd: 1, leftUsd: 9, wPerUsd: 100, learned: false, leftW: 900 });
    // The 45% over the 132 hours to the pace end, a 24-hour day of it; Thursday 12:00 is half the day.
    assert.equal(round(week.allowancePct), round((45 * 24) / 132));
    assert.equal(round(week.teamDay?.pacePct), round((45 * 12) / 132));
    assert.equal(week.teamDay?.pastLimit, 'pool');
  });

  it('has no room past 100% while the pool is unset, spent or known in dollars only', () => {
    const extra = { entries: [ADDED], wAtFull: 1_400 };
    const none = readWeek({ readings: [], calibration: LEARNED, budget: DEFAULT_BUDGET, now: NOW, statusUse: FULL, period: PERIOD, states: COVERED });
    const dollarsOnly = readWeek({ readings: [], calibration: LEARNED, budget: DEFAULT_BUDGET, now: NOW, statusUse: FULL, period: PERIOD, states: COVERED, extra });
    // 100 W past the 100% line at 10 W per dollar spend the whole $10.
    const spent = readWeek({ readings: [], calibration: LEARNED, budget: { ...DEFAULT_BUDGET, extraWPerUsd: 10 }, now: NOW, statusUse: FULL, period: PERIOD, states: COVERED, extra });
    assert.deepEqual([none.pool, none.allowancePct, dollarsOnly.allowancePct, spent.allowancePct, spent.pool?.leftW], [undefined, 0, 0, 0, 0]);
    assert.deepEqual(dollarsOnly.pool, { addedUsd: 10, spentUsd: 0, leftUsd: 10, wPerUsd: undefined, learned: false, leftW: undefined });
    assert.deepEqual([none, dollarsOnly, spent].map((week) => week.teamDay?.pastLimit), ['empty', 'unpriced', 'empty']);
  });

  it("keeps the week's allowance below 100%: the pool waits, untouched", () => {
    const budget: BudgetConfig = { ...DEFAULT_BUDGET, extraWPerUsd: 100 };
    const early = { ...ADDED, weekPct: 57 };
    const week = readWeek({ readings: [], calibration: NONE, budget, now: NOW, statusUse: STATUS, period: PERIOD, states: COVERED, extra: { entries: [early], wAtFull: undefined } });
    assert.deepEqual(week.pool, { addedUsd: 10, spentUsd: 0, leftUsd: 10, wPerUsd: 100, learned: false, leftW: 1_000 });
    assert.equal(round(week.allowancePct), round((42.5 * 24) / 132));
    assert.deepEqual(Object.keys(week.teamDay ?? {}), ['usedPct', 'pacePct']);
  });
});

describe('coversFrom', () => {
  it("holds when a store counted the instant's UTC day or one before it, not while none did", () => {
    const from = Date.parse('2026-10-14T23:00:00Z');
    assert.deepEqual(
      [COVERED, [state({ '2026-10-14': 1 })], [state({ '2026-10-15': 1 })], [], [state({})]].map((states) => coversFrom(states, from)),
      [true, true, false, false, false],
    );
  });
});

describe('wSince', () => {
  const hours = { ...state({ '2026-10-13': 5_000, '2026-10-14': 1_000, '2026-10-15': 300 }), byHour: { '2026-10-14T00': 600, '2026-10-14T05': 400 } };

  it("counts the whole days after the instant's day and that day less its hours before the instant's hour", () => {
    assert.equal(wSince([hours], Date.parse('2026-10-14T01:30:00Z'), NOW), 400 + 300);
    assert.equal(wSince([hours], Date.parse('2026-10-14T05:59:00Z'), NOW), 400 + 300);
    assert.equal(wSince([hours], Date.parse('2026-10-14T06:00:00Z'), NOW), 0 + 300);
  });

  it('sums every store and leaves out the days after now', () => {
    const later = state({ '2026-10-14': 50, '2026-10-16': 7_000 });
    assert.equal(wSince([hours, later], Date.parse('2026-10-14T00:00:00Z'), NOW), 1_000 + 300 + 50);
  });

  it('counts a day whose hours sum past its W as none, never below zero', () => {
    const damaged = { ...state({ '2026-10-14': 100 }), byHour: { '2026-10-14T00': 600 } };
    assert.equal(wSince([damaged], Date.parse('2026-10-14T03:00:00Z'), NOW), 0);
  });
});

describe('idleWSince', () => {
  const nights = DailyProfile.ofQuietHours({ startUtc: '22:00', endUtc: '06:00', action: 'ask' });
  const hours = { ...state({ '2026-10-14': 999, '2026-10-15': 650 }), byHour: { '2026-10-14T23': 999, '2026-10-15T02': 300, '2026-10-15T05': 100, '2026-10-15T06': 50, '2026-10-15T09': 200 } };
  const midnight = Date.parse('2026-10-15T00:00:00Z');

  it('counts only the W of hours the profile does not count as active, from the instant to now', () => {
    assert.equal(idleWSince([hours], midnight, NOW, nights), 300 + 100);
    assert.equal(idleWSince([hours], midnight, Date.parse('2026-10-15T03:00:00Z'), nights), 300);
  });

  it("counts the instant's hour whole, as wSince does", () => {
    assert.equal(idleWSince([hours], Date.parse('2026-10-15T05:30:00Z'), NOW, nights), 100);
  });

  it("weighs a quiet hour by the part of it its paceWeight leaves idle, and sums every store", () => {
    const half = DailyProfile.ofQuietHours({ startUtc: '22:00', endUtc: '06:00', action: 'ask', paceWeight: 0.5 });
    const other = { ...state({ '2026-10-15': 40 }), byHour: { '2026-10-15T04': 40 } };
    assert.equal(idleWSince([hours, other], midnight, NOW, half), (300 + 100 + 40) / 2);
  });

  it('is none with no quiet hours, or for a store whose hours were lost', () => {
    assert.equal(idleWSince([hours], midnight, NOW, DailyProfile.even()), 0);
    assert.equal(idleWSince([state({ '2026-10-15': 650 })], midnight, NOW, nights), 0);
  });
});

describe('meteredOf', () => {
  it("counts the stores' W from an hour at the W per percent given, and is undefined without one", () => {
    const metered = meteredOf(1_000, COVERED, NOW);
    assert.equal(metered?.wPerPct, 1_000);
    assert.equal(metered?.wFrom(PERIOD.start), wSince(COVERED, PERIOD.start, NOW));
    assert.equal(meteredOf(undefined, COVERED, NOW), undefined);
  });
});

describe('rateOf', () => {
  it('takes the learned rate first, then budget.weeklyLimitW, then the estimate', () => {
    const limit = { weeklyLimitW: 100_000 };
    assert.deepEqual(rateOf(LEARNED, limit, 7), { wPerPct: 20, from: 'learned' });
    assert.deepEqual(rateOf(NONE, limit, 7), { wPerPct: 1_000, from: 'limit' });
    assert.deepEqual(rateOf(NONE, {}, 7), { wPerPct: 7, from: 'estimate' });
    assert.equal(rateOf(NONE, {}, undefined), undefined);
  });
});

describe('limitWPerPct', () => {
  it('reads the configured limit as W per percent, and nothing without one', () => {
    assert.deepEqual([limitWPerPct({ weeklyLimitW: 650_000_000 }), limitWPerPct({})], [6_500_000, undefined]);
  });
});
