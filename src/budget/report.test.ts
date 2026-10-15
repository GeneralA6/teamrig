import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Lift } from './lift.ts';
import { weekWindow } from './pace.ts';
import { emptyPatterns, type PatternField } from './patterns.ts';
import {
  loopLines,
  OVER_BUDGET_ADVICE,
  recountLines,
  sessionLines,
  sumDays,
  todayLines,
  W_EXPLAINED,
  type OutsideToday,
  type SessionToday,
  type TodayReport,
} from './report.ts';
import type { DayUsage, UsageState } from './store.ts';
import type { WeekReading } from './week.ts';

const RESET = Date.parse('2026-10-21T01:00:00Z');
const WINDOW = weekWindow(RESET, 1);
/** 57% used by the status line at 11:00, 1% of the week = 7.5M W, a 10.25% team allowance today. */
const WEEK: WeekReading = {
  reset: RESET,
  window: WINDOW,
  usedPct: 57,
  statusAt: Date.parse('2026-10-15T11:00:00Z'),
  wPerPct: 7_500_000,
  limitEstimated: true,
  covered: true,
  pace: { window: WINDOW, linePct: 20.853, gapPts: 36.147, state: 'ahead' },
  allowancePct: 10.25,
  todayW: 38_700_000,
};
const UNKNOWN: WeekReading = {
  reset: undefined,
  window: undefined,
  usedPct: undefined,
  statusAt: undefined,
  wPerPct: undefined,
  limitEstimated: false,
  covered: false,
  pace: undefined,
  allowancePct: undefined,
  todayW: 0,
};
const LIFT: Lift = {
  session: 'bravo',
  toPct: 2,
  stopPct: 97,
  endsAt: Date.parse('2026-10-16T00:00:00Z'),
  reserve: false,
  quietHoursExempt: true,
  reason: 'release',
  by: 'lead',
  at: Date.parse('2026-10-15T09:00:00Z'),
};

function session(id: string, w: number, calls: number, budgetPct: number | undefined = 10.25 / 3, lift: Lift | undefined = undefined): SessionToday {
  return { id, name: id === 'lead' ? 'team-lead' : id, w, calls, budgetPct, lift };
}

const SESSIONS: readonly SessionToday[] = [session('lead', 7_500_000, 310), session('alpha', 30_000_000, 1_000), session('bravo', 0, 0, 2, LIFT)];
const OUTSIDE: OutsideToday = { w: 1_200_000, calls: 40, sessions: 2, titles: ['release checks', 'Docs'] };
const NOBODY_OUTSIDE: OutsideToday = { w: 0, calls: 0, sessions: 0, titles: [] };
const REPORT: TodayReport = { week: WEEK, sessions: SESSIONS, outside: OUTSIDE, behind: [], all: false };

describe('todayLines', () => {
  it('gives the week, the team, each session with use, lifts, outside use and who is past budget', () => {
    assert.deepEqual(todayLines({ ...REPORT, behind: ['bravo'] }), [
      'Week: 57.0% used at 11:00 UTC (status line); the pace line is at 20.9%: 36.1 points ahead. Resets Wed 10-21 01:00 UTC.',
      'The team used 5.0% of the week today; its daily budget is 10.3%. 37.50M W in 1,310 calls.',
      'alpha used 4.0% of the week today; its daily budget is 3.4%. 30.00M W in 1,000 calls.',
      'team-lead used 1.0% of the week today; its daily budget is 3.4%. 7.50M W in 310 calls.',
      'Budget: the lead lifted bravo to 2.0% today until the end of the day (UTC) or 97.0% of the week, whichever comes first; quiet hours do not apply to it.',
      'Not on the team: 2 Claude Code sessions (titled release checks, Docs), 1.20M W today. ' +
        'A tab counts for a session once it runs teamrig inbox read --session <id> or is named after it.',
      'Still reading: bravo; run teamrig budget again for the rest.',
      `Past the daily budget: alpha. ${OVER_BUDGET_ADVICE}`,
      `${W_EXPLAINED} 1% of the week is about 7.50M W, estimated from the status line.`,
    ]);
  });

  it('never tells a session past budget to skip a test', () => {
    assert.doesNotMatch(OVER_BUDGET_ADVICE, /skip (a|the) test(?! or check to save)/);
    assert.match(OVER_BUDGET_ADVICE, /Never skip a test or check to save budget\. The lead can lift it\.$/);
  });

  it('marks a lifted budget and names the idle sessions with --all', () => {
    const lifted = [session('lead', 0, 0), session('alpha', 15_000_000, 500, 2, { ...LIFT, session: 'alpha' })];
    const lines = todayLines({ week: WEEK, sessions: lifted, outside: { ...NOBODY_OUTSIDE, sessions: 1 }, behind: [], all: true });
    assert.deepEqual(lines.slice(2, 5), [
      'alpha used 2.0% of the week today; its daily budget is 2.0% (lifted). 15.00M W in 500 calls.',
      'No use today: team-lead.',
      'Budget: the lead lifted alpha to 2.0% today until the end of the day (UTC) or 97.0% of the week, whichever comes first; quiet hours do not apply to it.',
    ]);
    assert.equal(lines[5], 'Not on the team: 1 Claude Code session, 0 W today. A tab counts for a session once it runs teamrig inbox read --session <id> or is named after it.');
  });

  it('lists the busiest seven sessions and counts the rest, or all of them and every outside title with --all', () => {
    const many = Array.from({ length: 9 }, (_, index) => session(`s${index}`, (index + 1) * 1_000_000, 10));
    const titles = ['a', 'b', 'c', 'd', 'e', 'f'];
    const short = todayLines({ ...REPORT, sessions: many, outside: { ...OUTSIDE, sessions: 6, titles } });
    assert.deepEqual(short.slice(2, 4), [
      's8 used 1.2% of the week today; its daily budget is 3.4%. 9.00M W in 10 calls.',
      's7 used 1.1% of the week today; its daily budget is 3.4%. 8.00M W in 10 calls.',
    ]);
    assert.equal(short[9], '+2 more sessions with use today (--all lists them).');
    assert.match(short[10] ?? '', /\(titled a, b, c, d, e, \+1 more\)/);
    const all = todayLines({ ...REPORT, sessions: many, outside: { ...OUTSIDE, sessions: 6, titles }, all: true });
    assert.equal(all.filter((line) => /^s\d used/.test(line)).length, 9);
    assert.match(all.find((line) => line.startsWith('Not on the team')) ?? '', /\(titled a, b, c, d, e, f\)/);
  });

  it('shows plain W when the week is unknown', () => {
    assert.deepEqual(todayLines({ week: UNKNOWN, sessions: SESSIONS, outside: NOBODY_OUTSIDE, behind: [], all: false }), [
      'Week: its use is unknown: no status line reading (use teamrig statusline as the status line) and no budget.weeklyLimitW.',
      'The team used 37.50M W in 1,310 calls today.',
      'alpha used 30.00M W in 1,000 calls today.',
      'team-lead used 7.50M W in 310 calls today.',
      'Budget: the lead lifted bravo to 2.0% today until the end of the day (UTC) or 97.0% of the week, whichever comes first; quiet hours do not apply to it.',
      W_EXPLAINED,
    ]);
  });

  it('says how to get daily budgets when only the use is known, and marks a metered week and the team past budget', () => {
    const noLimit = todayLines({ ...REPORT, week: { ...WEEK, wPerPct: undefined, limitEstimated: false, pace: { window: WINDOW, linePct: 57.2, gapPts: -0.2, state: 'on pace' } } });
    assert.match(noLimit[0] ?? '', /the pace line is at 57\.2%: on pace\./);
    assert.equal(noLimit.at(-2), 'Daily budgets need the week in W: set budget.weeklyLimitW, or let teamrig meter a whole week to estimate it.');
    assert.equal(noLimit.at(-1), W_EXPLAINED);
    const metered = todayLines({ ...REPORT, week: { ...WEEK, statusAt: undefined, limitEstimated: false, allowancePct: 1 } });
    assert.match(metered[0] ?? '', /^Week: 57\.0% used \(metered\); /);
    assert.match(metered.find((line) => line.startsWith('Past the daily budget')) ?? '', /^Past the daily budget: the team, alpha\. /);
    assert.equal(metered.at(-1), W_EXPLAINED);
  });
});

describe('recountLines', () => {
  it('gives a past day with no budgets, saying nothing was written', () => {
    assert.deepEqual(recountLines('2026-10-14', { week: UNKNOWN, sessions: SESSIONS, outside: OUTSIDE, all: false }), [
      '2026-10-14 (UTC), recounted from the transcripts; nothing was written.',
      'The team used 37.50M W in 1,310 calls that day.',
      'alpha used 30.00M W in 1,000 calls that day.',
      'team-lead used 7.50M W in 310 calls that day.',
      'Not on the team: 2 Claude Code sessions (titled release checks, Docs), 1.20M W in 40 calls.',
      W_EXPLAINED,
    ]);
    const many = Array.from({ length: 8 }, (_, index) => session(`s${index}`, 1_000, 1));
    const lines = recountLines('2026-10-14', { week: WEEK, sessions: many, outside: NOBODY_OUTSIDE, all: false });
    assert.equal(lines[2], 's0 used 0.00% of the week that day. 1k W in 1 call.');
    assert.equal(lines[9], '+1 more sessions with use that day (--all lists them).');
    assert.equal(recountLines('2026-10-14', { week: WEEK, sessions: many, outside: NOBODY_OUTSIDE, all: true }).length, 11);
  });

  it('names the idle sessions and every outside title with --all', () => {
    const titles = ['a', 'b', 'c', 'd', 'e', 'f'];
    const lines = recountLines('2026-10-14', { week: UNKNOWN, sessions: SESSIONS, outside: { ...OUTSIDE, sessions: 6, titles }, all: true });
    assert.deepEqual(lines.slice(4, 6), ['No use that day: bravo.', 'Not on the team: 6 Claude Code sessions (titled a, b, c, d, e, f), 1.20M W in 40 calls.']);
    const short = recountLines('2026-10-14', { week: UNKNOWN, sessions: SESSIONS, outside: { ...OUTSIDE, sessions: 6, titles }, all: false });
    assert.equal(short[4], 'Not on the team: 6 Claude Code sessions (titled a, b, c, d, e, +1 more), 1.20M W in 40 calls.');
  });
});

function usage(w: number, calls: number, patterns: Partial<Record<PatternField, number>> = {}): DayUsage {
  return { w, calls, patterns: { ...emptyPatterns(), ...patterns } };
}

function state(byDay: Readonly<Record<string, DayUsage>>): UsageState {
  return { byDay, cursors: {}, recentKeys: [] };
}

describe('sessionLines', () => {
  it("gives the session's use by day, newest first, its budget today and its lift", () => {
    const stored = state({ '2026-10-14': usage(15_000_000, 600), '2026-10-15': usage(7_500_000, 1) });
    assert.deepEqual(sessionLines(session('bravo', 7_500_000, 1, 2, LIFT), stored, WEEK), [
      'bravo (bravo), by UTC day:',
      '  2026-10-15  7.50M W in 1 call, 1.0% of the week',
      '  2026-10-14  15.00M W in 600 calls, 2.0% of the week',
      'Its daily budget today is 2.0% of the week (lifted).',
      'Budget: the lead lifted bravo to 2.0% today until the end of the day (UTC) or 97.0% of the week, whichever comes first; quiet hours do not apply to it.',
      W_EXPLAINED,
    ]);
  });

  it('says when there is no use and no budget', () => {
    const unbudgeted: SessionToday = { id: 'lead', name: 'team-lead', w: 0, calls: 0, budgetPct: undefined, lift: undefined };
    assert.deepEqual(sessionLines(unbudgeted, state({}), UNKNOWN), ['team-lead (lead), by UTC day:', '  no use in the last 8 days', W_EXPLAINED]);
    assert.deepEqual(sessionLines(unbudgeted, state({ '2026-10-15': usage(500, 2) }), UNKNOWN).slice(1, 2), ['  2026-10-15  500 W in 2 calls']);
  });
});

describe('loop patterns', () => {
  const DAYS = ['2026-10-13', '2026-10-14'];

  it('sums the days over several stores, a missing day as zero', () => {
    const totals = sumDays(
      [state({ '2026-10-13': usage(100, 2, { readChain: 3, readChainW: 50 }) }), state({ '2026-10-13': usage(10, 1, { readChain: 1 }), '2026-10-12': usage(9, 9) })],
      DAYS,
    );
    assert.deepEqual(totals, [usage(110, 3, { readChain: 4, readChainW: 50 }), usage(0, 0)]);
  });

  it('tables each pattern by day, its count then its W', () => {
    const totals = [usage(261_060_000, 12_372, { readChain: 2_634, readChainW: 42_000_000, editTestJoined: 116 }), usage(0, 0)];
    const row = (label: string, first: string, second: string): string => `${label.padEnd(27)}  ${first.padStart(14)}  ${second.padStart(5)}`;
    assert.deepEqual(loopLines('every session', DAYS, totals), [
      'Loop patterns, every session: count, then W (UTC days)',
      row('', '10-13', '10-14'),
      row('read after read, W', '2,634 42.00M', '0 0'),
      row('edit after edit, W saved', '0 0', '0 0'),
      row('test after an edit, W saved', '0 0', '0 0'),
      row('  edit and test in one call', '116', '0'),
      row('rerun, piped failure, W', '0 0', '0 0'),
      row('rerun, full failure, W', '0 0', '0 0'),
      row('rerun after a pass, W', '0 0', '0 0'),
      row('passing test runs, rent W', '0 0', '0 0'),
      row('  their output tokens', '0', '0'),
      row('all calls', '12,372 261.06M', '0 0'),
    ]);
  });
});
