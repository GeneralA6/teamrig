import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { WeekWindow } from './pace.ts';
import type { BudgetSplit } from './parts.ts';
import { emptyPatterns } from './patterns.ts';
import { EMPTY_USAGE, type UsageState } from './store.ts';
import { keepTeamWeek, teamWeekSummaryOf, type TeamWeekInput } from './team-week-file.ts';
import { formatTeamWeek, parseTeamWeek, TEAM_WEEK_FORMAT } from './team-week-summary.ts';

const WINDOW: WeekWindow = { start: Date.parse('2030-01-07T01:00:00Z'), reset: Date.parse('2030-01-14T01:00:00Z'), paceEnd: Date.parse('2030-01-13T21:00:00Z') };
const NOW = Date.parse('2030-01-08T10:00:00Z');
const PATH = '/kit/teams/app/state/usage/team.week.json';

/** A team's split, its sessions at the default share with no queued work. */
function splitOf(team: string, ids: readonly string[]): BudgetSplit {
  return { team, ids, sessions: {}, leads: {}, work: new Map(), lifted: new Map(), liftedGroups: new Map(), crossLifted: new Map(), pausable: new Set(), funded: new Map() };
}

/** A usage store with `w` W on each day. */
function used(byDay: Readonly<Record<string, number>>): UsageState {
  return { ...EMPTY_USAGE, byDay: Object.fromEntries(Object.entries(byDay).map(([day, w]) => [day, { w, calls: 1, patterns: emptyPatterns() }])) };
}

/** The app team alone on the account at 10M W per percent, the account 30% used: lead 50M W today, alpha 100M W yesterday. */
function input(extra: Partial<TeamWeekInput> = {}): TeamWeekInput {
  return {
    window: WINDOW,
    usedPct: 30,
    wPerPct: 10_000_000,
    targetPct: 99.5,
    states: [used({ '2030-01-08': 50_000_000 }), used({ '2030-01-07': 100_000_000 })],
    teams: { split: splitOf('app', ['lead', 'alpha', 'bravo']), others: [] },
    now: NOW,
    ...extra,
  };
}

describe('teamWeekSummaryOf', () => {
  it("reads the team's W since the week began at its own rate, and plans it all the account has left alone on it", () => {
    assert.deepEqual(teamWeekSummaryOf(input()), { usedPct: 15, plannedPct: 84.5, accountUsedPct: 30, resetsAt: WINDOW.reset, at: NOW });
  });

  it("plans the team only its part of what is left beside another team on the account, by the sessions' weights", () => {
    const summary = teamWeekSummaryOf(input({ targetPct: 98, teams: { split: splitOf('app', ['lead', 'alpha', 'bravo']), others: [splitOf('web', ['lead'])] } }));
    assert.equal(summary?.usedPct, 15);
    assert.equal(summary?.plannedPct, 15 + 51, "three sessions of four on the account: three quarters of the 68% left");
  });

  it('counts no W from before the week began', () => {
    const summary = teamWeekSummaryOf(input({ states: [used({ '2030-01-06': 900_000_000, '2030-01-08': 50_000_000 })] }));
    assert.equal(summary?.usedPct, 5);
  });

  it('plans no more than the team used once the account is past its target', () => {
    const summary = teamWeekSummaryOf(input({ usedPct: 99.9 }));
    assert.equal(summary?.plannedPct, summary?.usedPct);
  });

  it('rounds the percents to hundredths and the time down to the minute', () => {
    const summary = teamWeekSummaryOf(input({ usedPct: 30.123_45, wPerPct: 3_000_000, now: NOW + 59_999 }));
    assert.deepEqual(summary, { usedPct: 50, plannedPct: 119.38, accountUsedPct: 30.12, resetsAt: WINDOW.reset, at: NOW });
  });

  it('reads nothing while the week, its use or the rate is unknown', () => {
    assert.equal(teamWeekSummaryOf(input({ window: undefined })), undefined);
    assert.equal(teamWeekSummaryOf(input({ usedPct: undefined })), undefined);
    assert.equal(teamWeekSummaryOf(input({ wPerPct: undefined })), undefined);
    assert.equal(teamWeekSummaryOf(input({ wPerPct: 0 })), undefined);
  });
});

describe('keepTeamWeek', () => {
  const summary = { usedPct: 15, plannedPct: 84.5, accountUsedPct: 30, resetsAt: WINDOW.reset, at: NOW };

  it('writes the summary, and again only when it changes', async () => {
    const files = new MemoryFiles();
    assert.equal(await keepTeamWeek(files, PATH, summary), true);
    assert.deepEqual(parseTeamWeek((await files.read(PATH)) ?? ''), summary);
    assert.equal(await keepTeamWeek(files, PATH, summary), false, 'the same summary is not written again');
    assert.equal(await keepTeamWeek(files, PATH, { ...summary, usedPct: 15.01 }), true);
    assert.equal(parseTeamWeek((await files.read(PATH)) ?? '')?.usedPct, 15.01);
  });

  it('replaces a damaged summary', async () => {
    const files = new MemoryFiles();
    await files.write(PATH, '{"v":1,"usedP');
    assert.equal(await keepTeamWeek(files, PATH, summary), true);
    assert.equal(await files.read(PATH), formatTeamWeek(summary));
  });

  it('leaves a summary a newer teamrig wrote as it is, without failing', async () => {
    const files = new MemoryFiles();
    const newer = JSON.stringify({ v: TEAM_WEEK_FORMAT + 1, usedPct: 1 });
    await files.write(PATH, newer);
    assert.equal(await keepTeamWeek(files, PATH, summary), false);
    assert.equal(await files.read(PATH), newer);
  });
});
