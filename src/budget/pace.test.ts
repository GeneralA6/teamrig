import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET } from '../config/defaults.ts';
import type { BudgetReset } from '../config/types.ts';
import { MS_PER_DAY, MS_PER_HOUR } from '../core/time.ts';
import {
  dailyAllowancePct,
  dayPacePct,
  hasRoom,
  nextConfiguredReset,
  paceLineOfWeek,
  paceLinePct,
  readPace,
  resolveReset,
  spanAllowancePct,
  weekWindow,
  type PaceBudget,
} from './pace.ts';
import { DailyProfile } from './active-time.ts';

const EVEN = DailyProfile.even();
const NIGHTS = DailyProfile.ofQuietHours({ startUtc: '22:00', endUtc: '06:00', action: 'ask' });
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
    assert.equal(paceLinePct(window, 99.5, window.start - MS_PER_HOUR, EVEN), 0);
    assert.equal(paceLinePct(window, 99.5, window.start, EVEN), 0);
    assert.equal(round(paceLinePct(window, 99.5, half, EVEN)), 49.75);
    assert.equal(paceLinePct(window, 99.5, window.paceEnd, EVEN), 99.5);
    assert.equal(paceLinePct(window, 99.5, window.reset, EVEN), 99.5);
  });

  it('gives the target at once when the pace line has no length', () => {
    assert.equal(paceLinePct({ start: RESET, paceEnd: RESET, reset: RESET }, 90, RESET - MS_PER_DAY, EVEN), 90);
  });

  it('rises only in active time, so it is flat through the quiet hours', () => {
    // Wed 01:00 to Wed 00:00, quiet 22:00-06:00: 16 active hours on each of the seven days, 112 in all.
    const night = paceLinePct(window, 99.5, at('2026-10-18T22:00:00Z'), NIGHTS);
    assert.equal(paceLinePct(window, 99.5, at('2026-10-19T05:00:00Z'), NIGHTS), night);
    assert.equal(round(night), round((99.5 * (16 * 5)) / 112));
  });

  it('is not falsely ahead in the evening: five active days of use meet the active line at 22:00, not the even one', () => {
    // Wed 01:00 to Sun 22:00 is 80 of the 112 active hours but 117 of the 167 clock hours.
    const evening = at('2026-10-18T22:00:00Z');
    assert.equal(round(paceLinePct(window, 99.5, evening, NIGHTS)), round((99.5 * 80) / 112));
    assert.equal(round(paceLinePct(window, 99.5, evening, EVEN)), round((99.5 * 117) / 167));
  });

  it('rises with clock time when the pace span has no active time', () => {
    const asleep = { activeMs: (): number => 0 };
    const half = window.start + (window.paceEnd - window.start) / 2;
    assert.equal(round(paceLinePct(window, 99.5, half, asleep)), 49.75);
  });
});

describe('paceLineOfWeek', () => {
  const window = weekWindow(RESET, 1);
  const evening = at('2026-10-18T22:00:00Z');

  it("stands where the pace line of the seven days before the reset does, by the budget's target and pace end", () => {
    assert.equal(paceLineOfWeek(RESET, DEFAULT_BUDGET, evening), paceLinePct(window, 99.5, evening, EVEN));
    assert.equal(paceLineOfWeek(RESET, { ...DEFAULT_BUDGET, targetPct: 80, paceEndHoursBeforeReset: 0 }, evening), paceLinePct(weekWindow(RESET, 0), 80, evening, EVEN));
  });

  it("counts only the active time outside the budget's quiet hours", () => {
    const quietHours = { startUtc: '22:00', endUtc: '06:00', action: 'ask' } as const;
    assert.equal(round(paceLineOfWeek(RESET, { ...DEFAULT_BUDGET, quietHours }, evening) ?? 0), round((99.5 * 80) / 112));
  });

  it('is undefined once the week reset, so a stale reading shows no pace', () => {
    assert.equal(paceLineOfWeek(RESET, DEFAULT_BUDGET, RESET), undefined);
    assert.equal(paceLineOfWeek(RESET, DEFAULT_BUDGET, RESET + MS_PER_HOUR), undefined);
  });
});

describe('dailyAllowancePct', () => {
  const window = weekWindow(RESET, 1);
  const thursday = at('2026-10-15T08:10:00Z');
  /** Thursday 08:10 to Wednesday 00:00. */
  const hoursLeft = 5 * 24 + 15 + 50 / 60;

  function allowance(now: number, usedPct: number, todayPct: number, profile = EVEN): number {
    return dailyAllowancePct({ window, budget: BUDGET, now, usedPct, todayPct, profile });
  }

  it('spreads what is left to the target now over the time to the pace end, a day of it', () => {
    assert.equal(round(allowance(thursday, 42.5, 3)), round((57 * 24) / hoursLeft));
  });

  it('holds all day on pace, in active time', () => {
    const line = (iso: string): number => paceLinePct(window, 99.5, at(iso), NIGHTS);
    const morning = allowance(at('2026-10-15T06:30:00Z'), line('2026-10-15T06:30:00Z'), 0.2, NIGHTS);
    const evening = allowance(at('2026-10-15T21:30:00Z'), line('2026-10-15T21:30:00Z'), 13.5, NIGHTS);
    assert.equal(round(morning), round((99.5 * 16) / 112));
    assert.equal(round(evening), round(morning));
  });

  it('rises while the team uses less than the pace and falls while it uses more', () => {
    const on = allowance(thursday, 42.5, 3);
    assert.ok(allowance(thursday, 40, 0.5) > on);
    assert.ok(allowance(thursday, 50, 10.5) < on);
    assert.equal(allowance(thursday, 101, 1), 0);
  });

  it('does not shrink through an idle evening', () => {
    const noon = allowance(at('2026-10-15T12:00:00Z'), 42.5, 3, NIGHTS);
    const evening = allowance(at('2026-10-15T21:00:00Z'), 42.5, 3, NIGHTS);
    assert.ok(evening > noon, `${evening} > ${noon}`);
  });

  it('is never above today\'s use plus what is left, which is all it is past the pace end', () => {
    // Tuesday 20:00, two active hours left: a day at that rate would be 8 times what is left.
    assert.equal(round(allowance(at('2026-10-20T20:00:00Z'), 94.5, 10, NIGHTS)), 15);
    assert.equal(round(allowance(at('2026-10-21T00:30:00Z'), 99, 0.2)), 0.7);
  });

  it('counts the reset day from the reset', () => {
    const next = weekWindow(at('2026-10-28T01:00:00Z'), 1);
    const resetDay = dailyAllowancePct({ window: next, budget: BUDGET, now: at('2026-10-21T05:00:00Z'), usedPct: 2, todayPct: 3.5, profile: EVEN });
    assert.equal(round(resetDay), round((97.5 * 23) / (6 * 24 + 19)));
  });
});

describe('spanAllowancePct', () => {
  const window = weekWindow(RESET, 1);
  const thursday = at('2026-10-15T08:10:00Z');

  function span(end: string, usedPct: number, todayPct: number): number {
    return spanAllowancePct({ start: window.start, end: at(end), stopPct: 60, now: thursday, usedPct, todayPct, profile: EVEN });
  }

  it('spreads what is left to its stop % over the time to its end, a day of it', () => {
    // Thursday 08:10 to Friday 08:10 is a day: all of the 17.5 left is today's.
    assert.equal(round(span('2026-10-16T08:10:00Z', 42.5, 3)), 17.5);
    assert.equal(round(span('2026-10-17T08:10:00Z', 42.5, 3)), 8.75);
  });

  it("is never above today's use plus what is left when it ends today", () => {
    // Ten hours left to 18:10, but eighteen of today's: at that rate a day would be 31.8.
    assert.equal(round(span('2026-10-15T18:10:00Z', 42.5, 3)), 20.5);
  });

  it('gives nothing past its stop % beyond what today used', () => {
    assert.equal(span('2026-10-16T08:10:00Z', 61, 3), 0);
  });

  it("is the team's allowance over the week to its pace end, up to the target", () => {
    const reading = { now: thursday, usedPct: 42.5, todayPct: 3, profile: NIGHTS };
    assert.equal(
      spanAllowancePct({ ...reading, start: window.start, end: window.paceEnd, stopPct: BUDGET.targetPct }),
      dailyAllowancePct({ ...reading, window, budget: BUDGET }),
    );
  });
});

describe('dayPacePct and hasRoom', () => {
  const window = weekWindow(RESET, 1);

  function pace(iso: string, profile = EVEN, inWindow = window, idlePct = 0): number {
    return dayPacePct({ window: inWindow, now: at(iso), allowancePct: 12, idlePct, profile });
  }

  it("is the allowance times the part of today's active time gone by", () => {
    assert.equal(round(pace('2026-10-15T06:00:00Z')), 3);
    assert.equal(round(pace('2026-10-15T06:00:00Z', NIGHTS)), 0);
    assert.equal(round(pace('2026-10-15T14:00:00Z', NIGHTS)), 6);
    assert.equal(round(pace('2026-10-15T23:00:00Z', NIGHTS)), 12);
  });

  it("starts from today's use in inactive time, so a night worked through quiet hours is not past the pace by morning", () => {
    assert.equal(round(pace('2026-10-15T06:00:00Z', NIGHTS, window, 4)), 4);
    assert.equal(round(pace('2026-10-15T14:00:00Z', NIGHTS, window, 4)), 10);
    assert.equal(hasRoom({ usedPct: 4.1, pacePct: pace('2026-10-15T06:30:00Z', NIGHTS, window, 4) }), true);
  });

  it('counts the reset day from the reset, and is the whole allowance with no active time left today', () => {
    const next = weekWindow(at('2026-10-28T01:00:00Z'), 1);
    assert.equal(round(pace('2026-10-21T05:00:00Z', EVEN, next)), round((12 * 4) / 23));
    assert.equal(pace('2026-10-21T00:30:00Z'), 12);
  });

  it('has room only below the pace', () => {
    assert.equal(hasRoom({ usedPct: 2.9, pacePct: 3 }), true);
    assert.equal(hasRoom({ usedPct: 3, pacePct: 3 }), false);
    assert.equal(hasRoom({ usedPct: 0, pacePct: 0 }), false);
  });
});

describe('readPace', () => {
  const window = weekWindow(RESET, 1);
  const half = window.start + (window.paceEnd - window.start) / 2;

  it('reads ahead, behind and on pace within the tolerance', () => {
    assert.equal(readPace(window, BUDGET, half, 55, EVEN).state, 'ahead');
    assert.equal(round(readPace(window, BUDGET, half, 55, EVEN).gapPts), 5.25);
    assert.equal(readPace(window, BUDGET, half, 45, EVEN).state, 'behind');
    assert.equal(readPace(window, BUDGET, half, 50, EVEN).state, 'on pace');
    assert.equal(readPace(window, { ...BUDGET, paceTolerancePct: 0 }, half, 50, EVEN).state, 'ahead');
  });

  it('reads the line of the profile it is given', () => {
    const evening = at('2026-10-18T22:00:00Z');
    const used = (99.5 * (16 * 5)) / 112;
    assert.equal(readPace(window, BUDGET, evening, used, NIGHTS).state, 'on pace');
    assert.equal(readPace(window, BUDGET, evening, used, EVEN).state, 'ahead');
  });
});
