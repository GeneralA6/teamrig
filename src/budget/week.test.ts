import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET } from '../config/defaults.ts';
import type { BudgetConfig } from '../config/types.ts';
import { emptyPatterns } from './patterns.ts';
import type { Period } from './period.ts';
import type { WeekUse } from './snapshot.ts';
import type { UsageState } from './store.ts';
import { meteredOf, readWeek, wSince } from './week.ts';

/** Thursday 2026-10-15 12:00 UTC; the week runs from Wednesday 10-14 01:00 to Wednesday 10-21 01:00. */
const NOW = Date.parse('2026-10-15T12:00:00Z');
const RESET = Date.parse('2026-10-21T01:00:00Z');
const STATUS: WeekUse = { usedPct: 57, resetsAt: RESET, at: Date.parse('2026-10-15T11:00:00Z') };
/** The period of that week. */
const PERIOD: Pick<Period, 'start' | 'end' | 'kind'> = { start: Date.parse('2026-10-14T01:00:00Z'), end: RESET, kind: 'week' };

function state(wByDay: Readonly<Record<string, number>>): UsageState {
  const byDay = Object.fromEntries(Object.entries(wByDay).map(([day, w]) => [day, { w, calls: 1, patterns: emptyPatterns() }]));
  return { byDay, byHour: {}, cursors: {}, recentKeys: [] };
}

/** Two sessions' stores reaching back to the week's first day: 1,000 W that day, 500 W today. */
const COVERED = [state({ '2026-10-14': 600, '2026-10-15': 300 }), state({ '2026-10-14': 400, '2026-10-15': 200, '2026-10-13': 9_999 })];

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 1000) / 1000;
}

describe('readWeek', () => {
  it('knows nothing but today\'s W without a status line, a limit or a reset', () => {
    const week = readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: undefined, period: undefined, states: COVERED });
    assert.deepEqual(week, {
      reset: undefined,
      window: undefined,
      periodKind: undefined,
      usedPct: undefined,
      statusAt: undefined,
      wPerPct: undefined,
      limitEstimated: false,
      covered: false,
      pace: undefined,
      allowancePct: undefined,
      todayFrom: Date.parse('2026-10-15T00:00:00Z'),
      todayW: 500,
      teamDay: undefined,
    });
  });

  it('takes the use and reset from the status line and estimates the limit once the week is metered whole', () => {
    const week = readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: PERIOD, states: COVERED });
    assert.deepEqual([week.reset, week.usedPct, week.statusAt, week.covered, week.limitEstimated], [RESET, 57, STATUS.at, true, true]);
    assert.equal(round(week.wPerPct), round(1_500 / 57));
    assert.equal(round(week.pace?.linePct), round((99.5 * 35) / 167));
    assert.equal(week.pace?.state, 'ahead');
    // 57% now: the 42.5% left over the 132 hours to the pace end, a 24-hour day of it.
    assert.equal(round(week.allowancePct), round((42.5 * 24) / 132));
  });

  it("counts the week from its reset's hour: the use before it that day is the last week's", () => {
    const resetDay = Date.parse('2026-10-14T12:00:00Z');
    const lastReset = Date.parse('2026-10-14T01:00:00Z');
    const status: WeekUse = { usedPct: 2, resetsAt: RESET, at: resetDay };
    const hours = { ...state({ '2026-10-13': 5_000, '2026-10-14': 1_000 }), byHour: { '2026-10-14T00': 600, '2026-10-14T05': 400 } };
    const week = readWeek({ budget: DEFAULT_BUDGET, now: resetDay, statusUse: status, period: PERIOD, states: [hours] });
    assert.deepEqual([week.window?.start, week.todayFrom], [lastReset, lastReset]);
    assert.deepEqual([week.todayW, week.wPerPct, week.teamDay?.usedPct], [400, 200, 2]);
  });

  it("counts a store whose hours were lost with its whole first day, as before hours were kept", () => {
    const resetDay = Date.parse('2026-10-14T12:00:00Z');
    const status: WeekUse = { usedPct: 2, resetsAt: RESET, at: resetDay };
    const week = readWeek({ budget: DEFAULT_BUDGET, now: resetDay, statusUse: status, period: PERIOD, states: [state({ '2026-10-13': 5_000, '2026-10-14': 1_000 })] });
    assert.deepEqual([week.todayW, week.wPerPct], [1_000, 500]);
  });

  it("counts a new budget from a reset inside the week: its pace line and today's use start there", () => {
    const reset = Date.parse('2026-10-15T10:00:00Z');
    const status: WeekUse = { usedPct: 1, resetsAt: RESET, at: NOW };
    const hours = { ...state({ '2026-10-14': 1_000, '2026-10-15': 300 }), byHour: { '2026-10-15T09': 200, '2026-10-15T10': 100 } };
    const week = readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: status, period: { start: reset, end: RESET, kind: 'reset' }, states: [hours] });
    assert.deepEqual([week.window?.start, week.periodKind, week.todayFrom, week.todayW, week.wPerPct, week.covered], [reset, 'reset', reset, 100, 100, true]);
    // 2 of the 134 hours from the reset to the pace end, an hour before the week's.
    assert.equal(round(week.pace?.linePct), round((99.5 * 2) / 134));
  });

  it('has no limit estimate while the stores start after the week did', () => {
    const late = [state({ '2026-10-15': 500 })];
    const week = readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: PERIOD, states: late });
    assert.deepEqual([week.usedPct, week.covered, week.wPerPct, week.allowancePct, week.limitEstimated], [57, false, undefined, undefined, false]);
  });

  it('meters the use from budget.weeklyLimitW when there is no status line', () => {
    const budget: BudgetConfig = { ...DEFAULT_BUDGET, weeklyLimitW: 100_000 };
    const week = readWeek({ budget, now: NOW, statusUse: undefined, period: PERIOD, states: COVERED });
    assert.deepEqual([week.reset, week.wPerPct, week.usedPct, week.statusAt, week.limitEstimated], [RESET, 1_000, 1.5, undefined, false]);
    assert.equal(week.pace?.state, 'behind');
    assert.equal(round(week.allowancePct), round((98 * 24) / 132));
  });

  it('paces by the active time of budget.quietHours', () => {
    const budget: BudgetConfig = { ...DEFAULT_BUDGET, quietHours: { startUtc: '22:00', endUtc: '06:00', action: 'ask' } };
    const week = readWeek({ budget, now: NOW, statusUse: STATUS, period: PERIOD, states: COVERED });
    // Wed 01:00 to Thu 12:00 is 16 + 6 of the week's 112 active hours; 42.5% left over the other 90, a 16-hour day of it.
    assert.equal(round(week.pace?.linePct), round((99.5 * 22) / 112));
    assert.equal(round(week.allowancePct), round((42.5 * 16) / 90));
    // Thursday 12:00 is 6 of the day's 16 active hours, and today's 500 W are 500 / (1,500 / 57) % of the week.
    assert.equal(round(week.teamDay?.pacePct), round((((42.5 * 16) / 90) * 6) / 16));
    assert.equal(round(week.teamDay?.usedPct), round((500 * 57) / 1_500));
  });

  it("has no allowance while the week's use cannot be read: no fixed number stands in for it", () => {
    const unknown = readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: undefined, period: PERIOD, states: [] });
    assert.deepEqual([unknown.allowancePct, unknown.teamDay], [undefined, undefined]);
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

describe('meteredOf', () => {
  it("counts the stores' W from an hour, at the configured W per percent, and is undefined without a limit", () => {
    const metered = meteredOf({ weeklyLimitW: 100_000 }, COVERED, NOW);
    assert.equal(metered?.wPerPct, 1_000);
    assert.equal(metered?.wFrom(PERIOD.start), wSince(COVERED, PERIOD.start, NOW));
    assert.equal(meteredOf({}, COVERED, NOW), undefined);
  });
});
