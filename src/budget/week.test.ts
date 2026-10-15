import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET } from '../config/defaults.ts';
import type { BudgetConfig } from '../config/types.ts';
import { emptyPatterns } from './patterns.ts';
import type { WeekUse } from './snapshot.ts';
import type { UsageState } from './store.ts';
import { readWeek } from './week.ts';

/** Thursday 2026-10-15 12:00 UTC; the week runs from Wednesday 10-14 01:00 to Wednesday 10-21 01:00. */
const NOW = Date.parse('2026-10-15T12:00:00Z');
const RESET = Date.parse('2026-10-21T01:00:00Z');
const STATUS: WeekUse = { usedPct: 57, resetsAt: RESET, at: Date.parse('2026-10-15T11:00:00Z') };

function state(wByDay: Readonly<Record<string, number>>): UsageState {
  const byDay = Object.fromEntries(Object.entries(wByDay).map(([day, w]) => [day, { w, calls: 1, patterns: emptyPatterns() }]));
  return { byDay, cursors: {}, recentKeys: [] };
}

/** Two sessions' stores reaching back to the week's first day: 1,000 W that day, 500 W today. */
const COVERED = [state({ '2026-10-14': 600, '2026-10-15': 300 }), state({ '2026-10-14': 400, '2026-10-15': 200, '2026-10-13': 9_999 })];

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 1000) / 1000;
}

describe('readWeek', () => {
  it('knows nothing but today\'s W without a status line, a limit or a reset', () => {
    const week = readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: undefined, states: COVERED });
    assert.deepEqual(week, {
      reset: undefined,
      window: undefined,
      usedPct: undefined,
      statusAt: undefined,
      wPerPct: undefined,
      limitEstimated: false,
      covered: false,
      pace: undefined,
      allowancePct: undefined,
      todayW: 500,
    });
  });

  it('takes the use and reset from the status line and estimates the limit once the week is metered whole', () => {
    const week = readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: COVERED });
    assert.deepEqual([week.reset, week.usedPct, week.statusAt, week.covered, week.limitEstimated], [RESET, 57, STATUS.at, true, true]);
    assert.equal(round(week.wPerPct), round(1_500 / 57));
    assert.equal(round(week.pace?.linePct), round((99.5 * 35) / 167));
    assert.equal(week.pace?.state, 'ahead');
    // 57% now, 19% of it today: 38% at 00:00, so (99.5 - 38) / 6 days to the pace end.
    assert.equal(round(week.allowancePct), 10.25);
  });

  it('has no limit estimate while the stores start after the week did', () => {
    const late = [state({ '2026-10-15': 500 })];
    const week = readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: late });
    assert.deepEqual([week.usedPct, week.covered, week.wPerPct, week.allowancePct, week.limitEstimated], [57, false, undefined, undefined, false]);
  });

  it('meters the use from budget.weeklyLimitW and budget.reset when there is no status line', () => {
    const budget: BudgetConfig = { ...DEFAULT_BUDGET, weeklyLimitW: 100_000, reset: { weekday: 'wed', timeUtc: '01:00' } };
    const week = readWeek({ budget, now: NOW, statusUse: undefined, states: COVERED });
    assert.deepEqual([week.reset, week.wPerPct, week.usedPct, week.statusAt, week.limitEstimated], [RESET, 1_000, 1.5, undefined, false]);
    assert.equal(week.pace?.state, 'behind');
    assert.equal(round(week.allowancePct), round((99.5 - 1) / 6));
  });

  it('falls back to a fixed dailyPct, capped, when the allowance cannot be worked out', () => {
    const budget: BudgetConfig = { ...DEFAULT_BUDGET, dailyPct: 2 };
    assert.equal(readWeek({ budget, now: NOW, statusUse: undefined, states: [] }).allowancePct, 2);
    assert.equal(readWeek({ budget: { ...budget, maxDailyPct: 1.5 }, now: NOW, statusUse: undefined, states: [] }).allowancePct, 1.5);
  });
});
