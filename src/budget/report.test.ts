import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { JERUSALEM } from '../testing/zone.ts';
import type { Burst } from './burst.ts';
import { calibrationOf } from './calibration.ts';
import type { ExtraPool } from './extra.ts';
import type { Lift } from './lift.ts';
import { weekWindow } from './pace.ts';
import { emptyPatterns, type PatternField } from './patterns.ts';
import {
  burnLines,
  loopLines,
  missLines,
  missMatrixLines,
  OVER_BUDGET_ADVICE,
  recountLines,
  sessionLines,
  sumDays,
  sumUsage,
  todayLines,
  W_EXPLAINED,
  type GroupToday,
  type OutsideToday,
  type SessionToday,
  type TodayReport,
} from './report.ts';
import type { DayUsage, UsageState } from './store.ts';
import type { WeekReading } from './week.ts';

/** An empty meter log. */
const NOTHING_LEARNED = calibrationOf([]);
const RESET = Date.parse('2026-10-21T01:00:00Z');
const WINDOW = weekWindow(RESET, 1);
/**
 * 57% used by the status line at 11:00, 1% of the week = 7.5M W, a 10.25% team allowance today; everyone's 5.16%
 * today is past the in-day pace of 10.25 × 11/24, so the team has no room.
 */
const WEEK: WeekReading = {
  reset: RESET,
  window: WINDOW,
  periodKind: 'week',
  usedPct: 57,
  statusAt: Date.parse('2026-10-15T11:00:00Z'),
  wPerPct: 7_500_000,
  rateFrom: 'estimate',
  calibration: NOTHING_LEARNED,
  covered: true,
  pace: { window: WINDOW, linePct: 20.853, gapPts: 36.147, state: 'ahead' },
  allowancePct: 10.25,
  plannedPct: (99.5 * 24) / 167,
  todayFrom: Date.parse('2026-10-15T00:00:00Z'),
  todayW: 38_700_000,
  todayWPerPct: 7_500_000,
  teamDay: { usedPct: 5.16, pacePct: (10.25 * 11) / 24 },
  pool: undefined,
};
const ROOM = { usedPct: 3, pacePct: (10.25 * 11) / 24 };
const UNKNOWN: WeekReading = {
  reset: undefined,
  window: undefined,
  periodKind: undefined,
  usedPct: undefined,
  statusAt: undefined,
  wPerPct: undefined,
  rateFrom: undefined,
  calibration: NOTHING_LEARNED,
  covered: false,
  pace: undefined,
  allowancePct: undefined,
  plannedPct: undefined,
  todayFrom: Date.parse('2026-10-15T00:00:00Z'),
  todayW: 0,
  todayWPerPct: undefined,
  teamDay: undefined,
  pool: undefined,
};
const LIFT: Lift = {
  session: 'bravo',
  partPct: 40,
  stopPct: 97,
  endsAt: Date.parse('2026-10-16T00:00:00Z'),
  reserve: false,
  group: false,
  quietHoursExempt: true,
  reason: 'release',
  by: 'lead',
  at: Date.parse('2026-10-15T09:00:00Z'),
};
const LIFT_HEADING =
  "Lifts, today only: a part of the team's daily budget until its time or its stop % of the week, whichever comes first; quiet hours do not apply to them.";
/** bravo's lift, which lasts the budget day, as `todayLines` gives it on UTC. */
const LIFT_BLOCK = [LIFT_HEADING, '  session   part      until  stop at', '  bravo    40.0%  00:00 UTC    97.0%', '  00:00 UTC is the end of the budget day.'];

function session(id: string, w: number, calls: number, budgetPct: number | undefined = 10.25 / 3, lift: Lift | undefined = undefined): SessionToday {
  return { id, name: id === 'lead' ? 'commander' : id, w, calls, budgetPct, lift, liftBy: lift === undefined ? undefined : 'commander', liftParent: undefined, liftWeekPct: undefined, inBurst: undefined, paused: false };
}

/** A surplus burst for alpha and bravo until the pace end, Wed 10-21 00:00 UTC, started at a 12.5% floor that is 9.5% now. */
const BURST: Burst = { kind: 'surplus', sessions: ['alpha', 'bravo'], helpers: 3, hires: 0, dailyPct: 12.5, stopPct: 99.5, endsAt: Date.parse('2026-10-21T00:00:00Z'), tasks: [], reason: 'surplus', by: 'lead', at: Date.parse('2026-10-19T09:00:00Z') };
const BURST_LINE = 'Budget: the lead started a surplus burst until Wed 10-21 00:00 UTC or 99.5% of the week';

function inBurst(id: string, w: number): SessionToday {
  return { ...session(id, w, 100, 9.5), inBurst: { burst: BURST, floorPct: 9.5 } };
}

const SESSIONS: readonly SessionToday[] = [session('lead', 7_500_000, 310), session('alpha', 30_000_000, 1_000), session('bravo', 0, 0, 2, LIFT)];
const OUTSIDE: OutsideToday = { w: 1_200_000, calls: 40, sessions: 2, titles: ['release checks', 'Docs'] };
const NOBODY_OUTSIDE: OutsideToday = { w: 0, calls: 0, sessions: 0, titles: [] };
const REPORT: TodayReport = { week: WEEK, teamPct: WEEK.allowancePct, sessions: SESSIONS, groups: [], outside: OUTSIDE, behind: [], all: false, zone: TimeZone.UTC };

describe('todayLines', () => {
  it("gives the week's status time and reset on the team's clock", () => {
    assert.equal(
      todayLines({ ...REPORT, zone: JERUSALEM })[0],
      'Week: 57.0% used at 14:00 IDT (status line); the pace line is at 20.9%: 36.1 points ahead. Resets Wed 10-21 04:00 IDT.',
    );
  });

  it('gives the day of a status line reading taken before today, so a stale one shows as stale', () => {
    const stale: WeekReading = { ...WEEK, statusAt: Date.parse('2026-10-14T18:46:00Z') };
    assert.match(todayLines({ ...REPORT, week: stale, zone: JERUSALEM })[0] ?? '', /^Week: 57\.0% used at 10-14 21:46 IDT \(status line\); /);
  });

  it('says where the use counts from after a reset inside the week, and how that start was found', () => {
    const window = weekWindow(RESET, 1, Date.parse('2026-10-18T16:00:00Z'));
    const fallen: WeekReading = { ...WEEK, window, periodKind: 'reset' };
    assert.match(todayLines({ ...REPORT, week: fallen })[0] ?? '', / Resets Wed 10-21 01:00 UTC\. Counted from Sun 10-18 16:00 UTC, after a reset inside the week\.$/);
    const inferred = todayLines({ ...REPORT, week: { ...fallen, periodKind: 'inferred' } })[0] ?? '';
    assert.match(inferred, / Counted from Sun 10-18 16:00 UTC, after a reset inside the week \(found from the metered W\)\.$/);
  });

  it('names the extra-usage pool after the week: what is left in dollars and, with its W per dollar, in W', () => {
    const pool: ExtraPool = { addedUsd: 10, spentUsd: 2, leftUsd: 8, wPerUsd: 2_000_000, learned: true, leftW: 16_000_000 };
    const first = (week: WeekReading): string => todayLines({ ...REPORT, week })[0] ?? '';
    assert.match(first({ ...WEEK, pool }), / Resets Wed 10-21 01:00 UTC\. Extra usage: \$8\.00 of \$10\.00 left, about 16\.00M W at 2\.00M W per dollar \(learned from spent readings\)\.$/);
    assert.match(first({ ...WEEK, pool: { ...pool, learned: false } }), / at 2\.00M W per dollar \(budget\.extraWPerUsd\)\.$/);
    const dollarsOnly: ExtraPool = { ...pool, wPerUsd: undefined, learned: false, leftW: undefined };
    assert.match(
      first({ ...WEEK, pool: dollarsOnly }),
      / Extra usage: \$8\.00 of \$10\.00 left, in dollars only until two spent readings past 100% \(teamrig budget extra --spent <usd>\) or budget\.extraWPerUsd give its W per dollar\.$/,
    );
  });

  it('gives the week, the team, each session with use, lifts, outside use and who is past budget', () => {
    assert.deepEqual(todayLines({ ...REPORT, behind: ['bravo'] }), [
      'Week: 57.0% used at 11:00 UTC (status line); the pace line is at 20.9%: 36.1 points ahead. Resets Wed 10-21 01:00 UTC.',
      'Today (UTC day), used and daily budget in % of the week:',
      '  session    used  budget       W  calls',
      '  the team   5.0%   10.3%  37.50M  1,310',
      '  alpha      4.0%    3.4%  30.00M  1,000',
      '  commander  1.0%    3.4%   7.50M    310',
      ...LIFT_BLOCK,
      'Not on the team: 2 Claude Code sessions (titled release checks, Docs), 1.20M W today. ' +
        'A tab counts for a session once it runs teamrig inbox read --session <id> or is named after it.',
      'Still reading: bravo; run teamrig budget again for the rest.',
      `Past the daily budget: alpha (the team has used 5.2% of the week today, at or past its in-day pace of 4.7%). ${OVER_BUDGET_ADVICE}`,
      `${W_EXPLAINED} 1% of the week is about 7.50M W, estimated from the status line.`,
    ]);
  });

  it("prices today's W at today's rate from the status line, and other days' at the week's", () => {
    // Today's 38.7M W read 2.58 points from the status line: 15M W per percent, twice the week's 7.5M.
    const week: WeekReading = { ...WEEK, todayWPerPct: 15_000_000, teamDay: { ...ROOM, usedPct: 2.58 } };
    const lines = todayLines({ ...REPORT, week });
    // commander's 7.5M W reads 0.50%, two decimals below 1%, which widens the column.
    assert.deepEqual(lines.slice(3, 6), [
      '  the team    2.5%   10.3%  37.50M  1,310',
      '  alpha       2.0%    3.4%  30.00M  1,000',
      '  commander  0.50%    3.4%   7.50M    310',
    ]);
    assert.equal(lines.find((line) => line.startsWith('Past')), undefined);
    const stored = state({ '2026-10-15': usage(7_500_000, 1) });
    assert.equal(sessionLines(session('bravo', 7_500_000, 1), stored, week, TimeZone.UTC)[1], '  2026-10-15  7.50M W in 1 call, 1.0% of the week');
  });

  it('gives a hold no in-day pace when the team has none', () => {
    const lines = todayLines({ ...REPORT, week: { ...WEEK, teamDay: undefined } });
    assert.equal(lines.find((line) => line.startsWith('Past')), `Past the daily budget: alpha. ${OVER_BUDGET_ADVICE}`);
  });

  it('never holds a session past its part while the team has room today', () => {
    const lines = todayLines({ ...REPORT, week: { ...WEEK, teamDay: ROOM } });
    assert.equal(lines.find((line) => line.startsWith('Past')), 'Past their part, not held while the team has room today (3.0% of the week used, below its in-day pace of 4.7%): alpha.');
    const teamPast = todayLines({ ...REPORT, teamPct: 1, week: { ...WEEK, teamDay: ROOM } });
    // Past its part of the account's day, the team is held though its use is below its in-day pace: no pace clause.
    assert.match(teamPast.find((line) => line.startsWith('Past')) ?? '', /^Past the daily budget: the team, alpha\. /);
  });

  it("gives the team its part of the account's daily budget, which another team on the account shrinks", () => {
    assert.match(todayLines({ ...REPORT, teamPct: 6 })[3] ?? '', /^ {2}the team +5\.0% +6\.0% +37\.50M +1,310$/);
  });

  it('never tells a session past budget to skip a test', () => {
    assert.doesNotMatch(OVER_BUDGET_ADVICE, /skip (a|the) test(?! or check to save)/);
    assert.match(OVER_BUDGET_ADVICE, /Never skip a test or check to save budget\. A session's leader can lift its budget\.$/);
  });

  it('marks the budgets a burst raised and names the burst once, with its sessions', () => {
    const lines = todayLines({ ...REPORT, sessions: [session('lead', 0, 0), inBurst('alpha', 15_000_000), inBurst('bravo', 0)], outside: NOBODY_OUTSIDE, all: true });
    assert.match(lines[4] ?? '', /^ {2}alpha +2\.0% +9\.5% +\(burst\) +15\.00M +100$/);
    assert.equal(lines[5], '  No use today: commander, bravo.');
    const burstLines = lines.filter((line) => line.startsWith('Budget: the lead started'));
    assert.equal(burstLines.length, 1, lines.join('\n'));
    assert.match(burstLines[0] ?? '', /: alpha, bravo each have a daily budget of at least 9\.5%, up to 3 helpers at once\. More: teamrig burst$/);
    assert.ok(burstLines[0]?.startsWith(BURST_LINE), burstLines[0]);
  });

  it('marks a paused budget, and names the paused sessions once, idle ones too, but not one a burst holds up', () => {
    const paused = (each: SessionToday): SessionToday => ({ ...each, budgetPct: 0, paused: true });
    const sessions = [session('lead', 7_500_000, 310), paused(session('alpha', 1_000_000, 40)), paused(session('bravo', 0, 0)), paused(inBurst('charlie', 2_000_000))];
    const lines = todayLines({ ...REPORT, sessions });
    assert.match(lines.find((line) => line.startsWith('  alpha')) ?? '', /^ {2}alpha +\S+% +0\.0% +\(paused\) +1\.00M +40$/);
    assert.match(lines.find((line) => line.startsWith('  charlie')) ?? '', / \(burst\) /);
    const pausedLines = lines.filter((line) => line.startsWith('Paused today'));
    assert.deepEqual(pausedLines, ["Paused today, funded by priority as the week's use is past its pace line (budget.pauseByPriority): alpha, bravo."]);
  });

  it('marks a lifted budget and names the idle sessions with --all', () => {
    const lifted = [session('lead', 0, 0), session('alpha', 15_000_000, 500, 2, { ...LIFT, session: 'alpha' })];
    const lines = todayLines({ ...REPORT, sessions: lifted, outside: { ...NOBODY_OUTSIDE, sessions: 1 }, all: true });
    assert.match(lines[4] ?? '', /^ {2}alpha +2\.0% +2\.0% +\(lifted\) +15\.00M +500$/);
    assert.deepEqual(lines.slice(5, 7), ['  No use today: commander.', LIFT_HEADING]);
    assert.match(lines[8] ?? '', /^ {2}alpha +40\.0% +00:00 UTC +97\.0%$/);
    assert.equal(lines[10], 'Not on the team: 1 Claude Code session, 0 W today. A tab counts for a session once it runs teamrig inbox read --session <id> or is named after it.');
  });

  it('lists the busiest seven sessions and counts the rest, or all of them and every outside title with --all', () => {
    const many = Array.from({ length: 9 }, (_, index) => session(`s${index}`, (index + 1) * 1_000_000, 10));
    const titles = ['a', 'b', 'c', 'd', 'e', 'f'];
    const short = todayLines({ ...REPORT, sessions: many, outside: { ...OUTSIDE, sessions: 6, titles } });
    const rows = (lines: readonly string[]): string[] => lines.filter((line) => /^ {2}s\d /.test(line));
    assert.equal(rows(short).length, 7);
    assert.match(short[4] ?? '', /^ {2}s8 +1\.2% +3\.4% +9\.00M +10$/);
    assert.match(short[5] ?? '', /^ {2}s7 +1\.1% +3\.4% +8\.00M +10$/);
    assert.equal(short[11], '  +2 more sessions with use today (--all lists them).');
    assert.match(short[12] ?? '', /\(titled a, b, c, d, e, \+1 more\)/);
    const all = todayLines({ ...REPORT, sessions: many, outside: { ...OUTSIDE, sessions: 6, titles }, all: true });
    assert.equal(rows(all).length, 9);
    assert.match(all.find((line) => line.startsWith('Not on the team')) ?? '', /\(titled a, b, c, d, e, f\)/);
  });

  it('shows plain W when the week is unknown', () => {
    assert.deepEqual(todayLines({ ...REPORT, week: UNKNOWN, teamPct: UNKNOWN.allowancePct, outside: NOBODY_OUTSIDE }), [
      'Week: its use is unknown: no status line reading (run teamrig statusline install) and no budget.weeklyLimitW.',
      'Today (UTC day):',
      '  session         W  calls',
      '  the team   37.50M  1,310',
      '  alpha      30.00M  1,000',
      '  commander   7.50M    310',
      ...LIFT_BLOCK,
      W_EXPLAINED,
    ]);
  });

  it("marks a reserve lift in its part, and names the budget day's end only for a lift that lasts it", () => {
    const reserve: Lift = { ...LIFT, reserve: true, endsAt: Date.parse('2026-10-15T23:45:00Z') };
    const lines = todayLines({ ...REPORT, sessions: [session('alpha', 1_000, 1), session('bravo', 0, 0, 2, reserve)] });
    const block = lines.slice(lines.indexOf(LIFT_HEADING), lines.indexOf(LIFT_HEADING) + 3);
    assert.deepEqual(block, [LIFT_HEADING, '  session             part      until  stop at', '  bravo    40.0% (reserve)  23:45 UTC    97.0%']);
    assert.ok(!lines.some((line) => line.includes('end of the budget day')), lines.join('\n'));
  });

  describe('with a sub-lead', () => {
    /** bravo leads alpha: the lead lifted bravo's group to 60% of the team's day, and bravo lifted alpha to 50% of its group's. */
    const GROUP_LIFT: Lift = { ...LIFT, group: true, partPct: 60, quietHoursExempt: false };
    const ALPHA_LIFT: Lift = { ...LIFT, session: 'alpha', partPct: 50, by: 'bravo' };
    const MEMBERS: readonly SessionToday[] = [session('lead', 7_500_000, 310), { ...session('alpha', 30_000_000, 1_000, 3, ALPHA_LIFT), liftBy: 'bravo', liftParent: 'bravo' }, session('bravo', 0, 0, 3)];
    const GROUP: GroupToday = { id: 'bravo', name: 'bravo', sessions: ['bravo', 'alpha'], budgetPct: 6, lift: GROUP_LIFT, liftBy: 'commander', liftParent: undefined, liftWeekPct: undefined };

    it("gives the group a row after the team's: its sessions' use summed against its part of the day", () => {
      const lines = todayLines({ ...REPORT, sessions: MEMBERS, groups: [GROUP] });
      assert.match(lines[3] ?? '', /^ {2}the team +5\.0% +10\.3% +37\.50M +1,310$/);
      assert.match(lines[4] ?? '', /^ {2}group bravo \(2\) +4\.0% +6\.0% +\(lifted\) +30\.00M +1,000$/);
      assert.match(lines[5] ?? '', /^ {2}alpha +4\.0% +3\.0% +\(lifted\) +30\.00M +1,000$/);
      const unknown = todayLines({ ...REPORT, week: UNKNOWN, teamPct: undefined, sessions: MEMBERS, groups: [{ ...GROUP, budgetPct: undefined }] });
      assert.match(unknown[4] ?? '', /^ {2}group bravo \(2\) +30\.00M +1,000$/);
    });

    it("lists the group's lift first and names the budget each lift is a part of, and that a group's keeps quiet hours", () => {
      const lines = todayLines({ ...REPORT, sessions: MEMBERS, groups: [GROUP] });
      const heading = lines.findIndex((line) => line.startsWith('Lifts, today only: '));
      assert.deepEqual(lines.slice(heading, heading + 5), [
        "Lifts, today only: a part of the team's or a group's daily budget until its time or its stop % of the week, whichever comes first; " +
          "quiet hours do not apply to a session's lift, but do to a group's.",
        '  session      of            part      until  stop at',
        '  group bravo  the team     60.0%  00:00 UTC    97.0%',
        '  alpha        group bravo  50.0%  00:00 UTC    97.0%',
        '  00:00 UTC is the end of the budget day.',
      ]);
    });

    it('shows a group with no lift unmarked, and no lifts block while nothing is lifted', () => {
      const lines = todayLines({ ...REPORT, sessions: [session('lead', 0, 0), session('alpha', 7_500_000, 5), session('bravo', 0, 0)], groups: [{ ...GROUP, lift: undefined, liftBy: undefined }] });
      assert.match(lines[4] ?? '', /^ {2}group bravo \(2\) +1\.0% +6\.0% +7\.50M +5$/);
      assert.ok(!lines.some((line) => line.startsWith('Lifts')), lines.join('\n'));
    });
  });

  it('says how to get daily budgets when only the use is known, and marks a metered week and the team past budget', () => {
    const noLimit = todayLines({ ...REPORT, week: { ...WEEK, wPerPct: undefined, rateFrom: undefined, pace: { window: WINDOW, linePct: 57.2, gapPts: -0.2, state: 'on pace' } } });
    assert.match(noLimit[0] ?? '', /the pace line is at 57\.2%: on pace\./);
    assert.equal(noLimit.at(-2), 'Daily budgets need the week in W: set budget.weeklyLimitW, or let teamrig meter a whole week to estimate it.');
    assert.equal(noLimit.at(-1), W_EXPLAINED);
    const metered = todayLines({ ...REPORT, teamPct: 1, week: { ...WEEK, statusAt: undefined, rateFrom: 'limit', allowancePct: 1 } });
    assert.match(metered[0] ?? '', /^Week: 57\.0% used \(metered\); /);
    assert.match(metered.find((line) => line.startsWith('Past the daily budget')) ?? '', /^Past the daily budget: the team, alpha\. /);
    assert.equal(metered.at(-1), W_EXPLAINED);
  });

  it("says a learned rate's readings, its misses and its latest periods' forecast misses", () => {
    const fit = { wPerPct: 9_100_000, errorPts: 0.42, readings: 57 };
    const periods = ['2026-09-23', '2026-09-30', '2026-10-07', '2026-10-14'].map((day, at) => ({ start: Date.parse(`${day}T01:00:00Z`), errorPts: at / 4, readings: 20 }));
    const learned = todayLines({ ...REPORT, week: { ...WEEK, wPerPct: fit.wPerPct, rateFrom: 'learned', calibration: { fit, periods } } });
    assert.equal(
      learned.at(-1),
      `${W_EXPLAINED} 1% of the week is about 9.10M W, learned from 57 meter readings, which it misses by 0.4 points. ` +
        'Its forecasts missed the status line by 0.3 points in the period from 09-30, 0.5 points in the period from 10-07, 0.8 points in the period from 10-14.',
    );
    const first = todayLines({ ...REPORT, week: { ...WEEK, wPerPct: fit.wPerPct, rateFrom: 'learned', calibration: { fit, periods: [] } } });
    assert.equal(first.at(-1), `${W_EXPLAINED} 1% of the week is about 9.10M W, learned from 57 meter readings, which it misses by 0.4 points.`);
  });
});

describe('recountLines', () => {
  it('gives a past day with no budgets, saying nothing was written', () => {
    assert.deepEqual(recountLines('2026-10-14', { week: UNKNOWN, sessions: SESSIONS, outside: OUTSIDE, all: false }), [
      '2026-10-14 (UTC), recounted from the transcripts; nothing was written.',
      'The team used 37.50M W in 1,310 calls that day.',
      'alpha used 30.00M W in 1,000 calls that day.',
      'commander used 7.50M W in 310 calls that day.',
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
  return { byDay, byHour: {}, byTask: {}, cursors: {}, recentKeys: [] };
}

describe('sessionLines', () => {
  it("gives the session's use by day, newest first, its budget today and its lift", () => {
    const stored = state({ '2026-10-14': usage(15_000_000, 600), '2026-10-15': usage(7_500_000, 1) });
    assert.deepEqual(sessionLines(session('bravo', 7_500_000, 1, 2, LIFT), stored, WEEK, TimeZone.UTC), [
      'bravo (bravo), by UTC day:',
      '  2026-10-15  7.50M W in 1 call, 1.0% of the week',
      '  2026-10-14  15.00M W in 600 calls, 2.0% of the week',
      'Its daily budget today is 2.0% of the week (lifted).',
      "Budget: commander lifted bravo to 40.0% of the team's daily budget today until 00:00 UTC (the end of the budget day) or 97.0% of the week, whichever comes first; quiet hours do not apply to it.",
      W_EXPLAINED,
    ]);
  });

  it("names the leader that lifted the session and the sub-lead's group whose daily budget the lift is a part of", () => {
    const lines = sessionLines({ ...session('bravo', 0, 0, 2, { ...LIFT, by: 'alpha' }), liftBy: 'alpha', liftParent: 'alpha' }, state({}), WEEK, TimeZone.UTC);
    assert.match(lines.find((line) => line.startsWith('Budget:')) ?? '', /^Budget: alpha lifted bravo to 40\.0% of alpha's group's daily budget today /);
  });

  it("gives the session's burst under its budget today", () => {
    const lines = sessionLines(inBurst('alpha', 0), state({}), WEEK, TimeZone.UTC);
    assert.equal(lines[2], 'Its daily budget today is 9.5% of the week (burst).');
    assert.match(lines[3] ?? '', /: alpha's daily budget is at least 9\.5%, up to 3 helpers at once\. More: teamrig burst$/);
    assert.ok(lines[3]?.startsWith(BURST_LINE), lines[3]);
  });

  it('says when there is no use and no budget', () => {
    const unbudgeted: SessionToday = { id: 'lead', name: 'commander', w: 0, calls: 0, budgetPct: undefined, lift: undefined, liftBy: undefined, liftParent: undefined, liftWeekPct: undefined, inBurst: undefined, paused: false };
    assert.deepEqual(sessionLines(unbudgeted, state({}), UNKNOWN, TimeZone.UTC), ['commander (lead), by UTC day:', '  no use in the last 8 days', W_EXPLAINED]);
    assert.deepEqual(sessionLines(unbudgeted, state({ '2026-10-15': usage(500, 2) }), UNKNOWN, TimeZone.UTC).slice(1, 2), ['  2026-10-15  500 W in 2 calls']);
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
    const totals = [usage(261_060_000, 12_372, { readChain: 2_634, readChainW: 42_000_000, editTestJoined: 116 }), usage(1_000, 3)];
    const row = (label: string, first: string, second: string): string => `${label.padEnd(27)}  ${first.padStart(14)}  ${second.padStart(5)}`;
    assert.deepEqual(loopLines('every session', DAYS, totals, 'metered'), [
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
      row('all calls', '12,372 261.06M', '3 1k'),
    ]);
  });

  it('leaves out the stored days with nothing metered and says how to read one, but shows a recounted day', () => {
    const lines = loopLines('every session', DAYS, [usage(0, 0), usage(1_000, 3)], 'metered');
    assert.match(lines[1] ?? '', /^ +10-14$/);
    assert.equal(lines.at(-2), `${'all calls'.padEnd(27)}   3 1k`);
    assert.equal(lines.at(-1), 'Left out, nothing metered: 10-13 (add --day 2026-10-13 to read one).');
    assert.equal(loopLines('lead', DAYS, [usage(0, 0), usage(0, 0)], 'recounted').at(-1), `${'all calls'.padEnd(27)}    0 0    0 0`);
    assert.deepEqual(loopLines('lead', DAYS, [usage(0, 0), usage(0, 0)], 'metered'), [
      'Loop patterns, lead: count, then W (UTC days)',
      'Left out, nothing metered: 10-13, 10-14 (add --day 2026-10-13 to read one).',
    ]);
  });
});

describe('burnLines', () => {
  const DAYS = ['2026-10-13', '2026-10-14'];

  it('tables what started the turns, cold calls, compactions and the read-after-read share by day', () => {
    const today = usage(1_000_000, 40, { ownerTurns: 2, ownerW: 600_000, peerTurns: 3, peerW: 400_000, coldCalls: 1, coldW: 50_000, compactions: 1, readChainW: 150_000 });
    const row = (label: string, cell: string): string => `${label.padEnd(36)}  ${cell.padStart(8)}`;
    assert.deepEqual(burnLines('lead', DAYS, [usage(0, 0), today], 'metered'), [
      'Burn, lead: count, then W (UTC days)',
      row('', '10-14'),
      row('owner turns, W', '2 600k'),
      row('peer messages, W', '3 400k'),
      row('notifications, W', '0 0'),
      row('scheduled wakes, W', '0 0'),
      row('subagent runs, W', '0 0'),
      row('other turns, W', '0 0'),
      row('not sorted (before 0.34.0), W', '0'),
      row('cold calls, cache-write W', '1 50k'),
      row('compactions', '1'),
      row('read after read, % of W (goal < 12%)', '15.0%'),
      row('all calls', '40 1.00M'),
      'Left out, nothing metered: 10-13 (add --day 2026-10-13 to read one).',
    ]);
  });

  it('leaves out a day metered before its turns were sorted, shows the rest of the upgrade day as not sorted, and shows a recounted day', () => {
    const lines = burnLines('lead', DAYS, [usage(1_000, 3), usage(3_000, 2, { otherTurns: 1, otherW: 1_000 })], 'metered');
    assert.match(lines.find((line) => line.startsWith('not sorted')) ?? '', / 2k$/);
    assert.equal(lines.at(-1), 'Left out, metered before teamrig 0.34.0: 10-13 (add --day 2026-10-13 to read one).');
    assert.match(burnLines('lead', DAYS, [usage(0, 0), usage(0, 0)], 'recounted')[1] ?? '', /10-13 +10-14$/);
    assert.match(burnLines('lead', DAYS, [usage(0, 0), usage(0, 0)], 'recounted').find((line) => line.startsWith('read after')) ?? '', / -  +-$/);
  });
});

const MISS_DAYS = ['2026-10-13', '2026-10-14'];

describe('sumUsage', () => {
  it('sums the use of several stores on one day, a missing one as zero', () => {
    assert.deepEqual(sumUsage([usage(1, 1, { missCalls: 1 }), undefined, usage(2, 3, { missCalls: 2, heavySteps: 1 })]), usage(3, 4, { missCalls: 3, heavySteps: 1 }));
    assert.deepEqual(sumUsage([]), usage(0, 0));
  });
});

describe('missLines', () => {
  it("tables each rule's misses out of its chances by day", () => {
    const today = usage(5_000, 20, {
      missCalls: 20,
      workBlocks: 2,
      missNoStart: 1,
      followupsNone: 3,
      missFollowupWords: 1,
      worktreeRemoves: 2,
      subagentW: 1_000,
      heavySteps: 4,
      missHeavyOutside: 3,
      missAdHocFetch: 1,
    });
    const row = (label: string, cell: string): string => `${label.padEnd(45)}  ${cell.padStart(5)}`;
    assert.deepEqual(missLines('lead', MISS_DAYS, [usage(0, 0), today], 'metered'), [
      'Rule misses, lead: misses/chances (UTC days)',
      row('', '10-14'),
      row('4 register: work blocks without teamrig start', '1/2'),
      row('4 register: --followups none, work left named', '1/3'),
      row('16 worktrees: plain git worktree remove', '0/2'),
      row("8 lean-calls: helpers' share of W", '20.0%'),
      row('tests and builds outside teamrig heavy', '3/4'),
      row('npx or dlx that fetches a package', '1'),
      row('calls read for misses', '20/20'),
      row('all calls', '20 5k'),
      'Left out, nothing metered: 10-13 (add --day 2026-10-13 to read one).',
    ]);
  });

  it('leaves out a day metered before misses were counted, and shows a recounted day', () => {
    const lines = missLines('lead', MISS_DAYS, [usage(1_000, 3), usage(2_000, 4, { missCalls: 2 })], 'metered');
    assert.match(lines.find((line) => line.startsWith('calls read')) ?? '', / 2\/4$/);
    assert.equal(lines.at(-1), 'Left out, metered before teamrig 0.87.0: 10-13 (add --day 2026-10-13 to read one).');
    const recounted = missLines('lead', MISS_DAYS, [usage(0, 0), usage(0, 0)], 'recounted');
    assert.match(recounted[1] ?? '', /10-13 +10-14$/);
    assert.match(recounted.find((line) => line.startsWith('8 lean-calls')) ?? '', / - +-$/);
  });
});

describe('missMatrixLines', () => {
  it('gives a row per session that made a call, its misses summed over the days', () => {
    const widths = [5, 7, 11, 11, 9, 5, 3, 5];
    const row = (...cells: readonly string[]): string =>
      cells
        .map((cell, index) => (index === 0 ? cell.padEnd(widths[0] ?? 0) : cell.padStart(widths[index] ?? 0)))
        .join('  ')
        .trimEnd();
    const lines = missMatrixLines(MISS_DAYS, [
      { name: 'lead', usage: usage(1_000, 10, { missCalls: 10, workBlocks: 1, missNoStart: 1, subagentW: 500 }) },
      { name: 'idle', usage: usage(0, 0) },
      { name: 'alpha', usage: usage(4_000, 8, { missCalls: 4, heavySteps: 2 }) },
    ]);
    assert.deepEqual(lines.slice(0, 4), [
      'Rule misses per session, misses/chances, 2026-10-13 to 2026-10-14 (UTC)',
      row('', '4 start', '4 followups', '16 worktree', '8 helpers', 'heavy', 'npx', 'read'),
      row('lead', '1/1', '0/0', '0/0', '50.0%', '0/0', '0', '10/10'),
      row('alpha', '0/0', '0/0', '0/0', '0.0%', '0/2', '0', '4/8'),
    ]);
    assert.equal(lines.length, 5);
    assert.ok(lines[4]?.startsWith('4 start = 4 register: work blocks without teamrig start; 4 followups = '), lines[4]);
    assert.ok(lines[4]?.endsWith('; read = calls read for misses. One session by day: teamrig budget <session> --misses.'), lines[4]);
  });

  it('says when no session made a call', () => {
    assert.deepEqual(missMatrixLines(['2026-10-13'], [{ name: 'idle', usage: usage(0, 0) }]), ['Rule misses per session, misses/chances, 2026-10-13 (UTC)', 'Nothing metered.']);
  });
});
