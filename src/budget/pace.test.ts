import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET } from '../config/defaults.ts';
import type { BudgetReset } from '../config/types.ts';
import { MS_PER_DAY, MS_PER_HOUR } from '../core/time.ts';
import {
  dailyAllowancePct,
  nextConfiguredReset,
  paceLinePct,
  readPace,
  resolveReset,
  sessionBudgetPct,
  weekWindow,
  type PaceBudget,
} from './pace.ts';

const WED_0100: BudgetReset = { weekday: 'wed', timeUtc: '01:00' };
/** Wednesday 2026-10-21 01:00 UTC, the reset after Thursday 2026-10-15. */
const RESET = Date.parse('2026-10-21T01:00:00Z');
const BUDGET: PaceBudget = DEFAULT_BUDGET;

function at(iso: string): number {
  return Date.parse(iso);
}

/** Rounds to 0.01 so float noise never fails a table. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

describe('nextConfiguredReset', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['2026-10-15T08:10:00Z', '2026-10-21T01:00:00.000Z'],
    ['2026-10-20T23:59:00Z', '2026-10-21T01:00:00.000Z'],
    ['2026-10-21T00:30:00Z', '2026-10-21T01:00:00.000Z'],
    ['2026-10-21T01:00:00Z', '2026-10-28T01:00:00.000Z'],
    ['2026-10-21T01:00:01Z', '2026-10-28T01:00:00.000Z'],
    ['2026-10-18T12:00:00Z', '2026-10-21T01:00:00.000Z'],
  ];
  for (const [now, expected] of cases) {
    it(`gives ${expected} at ${now}`, () => {
      assert.equal(new Date(nextConfiguredReset(at(now), WED_0100)).toISOString(), expected);
    });
  }

  it('reads a reset on a Sunday at midnight', () => {
    const reset = nextConfiguredReset(at('2026-10-17T23:00:00Z'), { weekday: 'sun', timeUtc: '00:00' });
    assert.equal(new Date(reset).toISOString(), '2026-10-18T00:00:00.000Z');
  });
});

describe('resolveReset', () => {
  const now = at('2026-10-15T08:10:00Z');

  it('prefers the status line when its reset is still ahead', () => {
    const fromStatus = at('2026-10-21T03:00:00Z');
    assert.equal(resolveReset(now, fromStatus, WED_0100), fromStatus);
  });

  it('falls back to the config when the status line reset has passed or is missing', () => {
    assert.equal(resolveReset(now, at('2026-10-14T01:00:00Z'), WED_0100), RESET);
    assert.equal(resolveReset(now, undefined, WED_0100), RESET);
  });

  it('is unknown with neither', () => {
    assert.equal(resolveReset(now, undefined, undefined), undefined);
  });
});

describe('weekWindow and paceLinePct', () => {
  const window = weekWindow(RESET, 1);

  it('starts a week before the reset and ends the pace line an hour before it', () => {
    assert.equal(new Date(window.start).toISOString(), '2026-10-14T01:00:00.000Z');
    assert.equal(new Date(window.paceEnd).toISOString(), '2026-10-21T00:00:00.000Z');
    assert.equal(weekWindow(RESET, 0).paceEnd, RESET);
  });

  it('rises evenly from 0 at the start to the target at the pace end, flat on either side', () => {
    const half = window.start + (window.paceEnd - window.start) / 2;
    assert.equal(paceLinePct(window, 99.5, window.start - MS_PER_HOUR), 0);
    assert.equal(paceLinePct(window, 99.5, window.start), 0);
    assert.equal(round(paceLinePct(window, 99.5, half)), 49.75);
    assert.equal(paceLinePct(window, 99.5, window.paceEnd), 99.5);
    assert.equal(paceLinePct(window, 99.5, window.reset), 99.5);
  });

  it('gives the target at once when the pace line has no length', () => {
    assert.equal(paceLinePct({ start: RESET, paceEnd: RESET, reset: RESET }, 90, RESET - MS_PER_DAY), 90);
  });
});

describe('dailyAllowancePct', () => {
  const window = weekWindow(RESET, 1);
  const thursday = at('2026-10-15T08:10:00Z');

  it('spreads what is left to the target at 00:00 over the days to the pace end', () => {
    // 42.5% used now, 3.0% of it today: 39.5% at 00:00, six days to Wednesday 00:00.
    assert.equal(round(dailyAllowancePct({ window, budget: BUDGET, now: thursday, usedPct: 42.5, todayPct: 3 })), 10);
  });

  it('stays the same through the day as the team uses it', () => {
    const morning = dailyAllowancePct({ window, budget: BUDGET, now: at('2026-10-15T00:05:00Z'), usedPct: 39.6, todayPct: 0.1 });
    const evening = dailyAllowancePct({ window, budget: BUDGET, now: at('2026-10-15T22:00:00Z'), usedPct: 48, todayPct: 8.5 });
    assert.equal(round(morning), round(evening));
  });

  it('gives all that is left on the last day and past the pace end', () => {
    assert.equal(round(dailyAllowancePct({ window, budget: BUDGET, now: at('2026-10-20T12:00:00Z'), usedPct: 92, todayPct: 2 })), 9.5);
    assert.equal(round(dailyAllowancePct({ window, budget: BUDGET, now: at('2026-10-21T00:30:00Z'), usedPct: 99, todayPct: 0.2 })), 0.7);
  });

  it('counts the reset day from the reset, with nothing used yet', () => {
    const next = weekWindow(at('2026-10-28T01:00:00Z'), 1);
    const allowance = dailyAllowancePct({ window: next, budget: BUDGET, now: at('2026-10-21T05:00:00Z'), usedPct: 2, todayPct: 3.5 });
    assert.equal(round(allowance), round(99.5 / (7 - 1 / 24)));
  });

  it('catches up: a week ahead of the line gets less each day, never below 0', () => {
    const ahead = dailyAllowancePct({ window, budget: BUDGET, now: thursday, usedPct: 70, todayPct: 4 });
    assert.equal(round(ahead), round((99.5 - 66) / 6));
    assert.equal(dailyAllowancePct({ window, budget: BUDGET, now: thursday, usedPct: 101, todayPct: 1 }), 0);
  });

  it('takes the fixed daily % and caps either at maxDailyPct', () => {
    const fixed = { ...BUDGET, dailyPct: 14 };
    assert.equal(dailyAllowancePct({ window, budget: fixed, now: thursday, usedPct: 42.5, todayPct: 3 }), 14);
    assert.equal(dailyAllowancePct({ window, budget: { ...fixed, maxDailyPct: 12 }, now: thursday, usedPct: 42.5, todayPct: 3 }), 12);
    assert.equal(dailyAllowancePct({ window, budget: { ...BUDGET, maxDailyPct: 8 }, now: thursday, usedPct: 42.5, todayPct: 3 }), 8);
  });
});

describe('sessionBudgetPct', () => {
  const ids = ['lead', 'alpha', 'bravo'];

  it('splits the allowance evenly by default', () => {
    assert.equal(sessionBudgetPct(9, 'alpha', ids, {}), 3);
  });

  it('splits by share', () => {
    assert.equal(sessionBudgetPct(8, 'alpha', ids, { alpha: { share: 2 } }), 4);
    assert.equal(sessionBudgetPct(8, 'bravo', ids, { alpha: { share: 2 }, bravo: { share: 0 } }), 0);
  });

  it('gives a fixed daily % as is and splits what is left among the others', () => {
    const sessions = { bravo: { share: 1, dailyPct: 1.5 } };
    assert.equal(sessionBudgetPct(9, 'bravo', ids, sessions), 1.5);
    assert.equal(sessionBudgetPct(9, 'alpha', ids, sessions), 3.75);
    assert.equal(sessionBudgetPct(1, 'alpha', ids, { bravo: { share: 1, dailyPct: 2 } }), 0);
  });

  it('gives 0 when no session takes a share', () => {
    assert.equal(sessionBudgetPct(9, 'alpha', ['alpha'], { alpha: { share: 0 } }), 0);
  });
});

describe('readPace', () => {
  const window = weekWindow(RESET, 1);
  const half = window.start + (window.paceEnd - window.start) / 2;

  it('reads ahead, behind and on pace within the tolerance', () => {
    assert.equal(readPace(window, BUDGET, half, 55).state, 'ahead');
    assert.equal(round(readPace(window, BUDGET, half, 55).gapPts), 5.25);
    assert.equal(readPace(window, BUDGET, half, 45).state, 'behind');
    assert.equal(readPace(window, BUDGET, half, 50).state, 'on pace');
    assert.equal(readPace(window, { ...BUDGET, paceTolerancePct: 0 }, half, 50).state, 'ahead');
  });
});
