import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryFiles } from '../testing/memory-files.ts';
import type { WeekWindow } from './pace.ts';
import { emptyPatterns } from './patterns.ts';
import { keepSessionsWeek, sessionsWeekOf, workHoursSince, type SessionsWeekInput } from './session-week-file.ts';
import { formatSessionsWeek, parseSessionsWeek, SESSIONS_WEEK_FORMAT } from './session-week-summary.ts';
import { EMPTY_USAGE, type UsageState } from './store.ts';

const WINDOW: WeekWindow = { start: Date.parse('2030-01-07T01:00:00Z'), reset: Date.parse('2030-01-14T01:00:00Z'), paceEnd: Date.parse('2030-01-13T21:00:00Z') };
const NOW = Date.parse('2030-01-08T10:00:00Z');
const PATH = '/kit/teams/app/state/usage/sessions.week.json';

/** A usage store with `w` W in each hour, each day's W the sum of its hours. */
function used(byHour: Readonly<Record<string, number>>): UsageState {
  const byDay: Record<string, number> = {};
  for (const [hour, w] of Object.entries(byHour)) {
    const day = hour.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + w;
  }
  return {
    ...EMPTY_USAGE,
    byHour,
    byDay: Object.fromEntries(Object.entries(byDay).map(([day, w]) => [day, { w, calls: 1, patterns: emptyPatterns() }])),
  };
}

/** The app team at 10M W per percent: lead 50M W in two hours today, alpha 100M W in three hours yesterday, bravo idle. */
function input(extra: Partial<SessionsWeekInput> = {}): SessionsWeekInput {
  return {
    window: WINDOW,
    wPerPct: 10_000_000,
    byId: new Map([
      ['lead', used({ '2030-01-08T08': 20_000_000, '2030-01-08T09': 30_000_000 })],
      ['alpha', used({ '2030-01-07T10': 40_000_000, '2030-01-07T11': 40_000_000, '2030-01-07T15': 20_000_000 })],
      ['bravo', EMPTY_USAGE],
    ]),
    now: NOW,
    ...extra,
  };
}

describe('sessionsWeekOf', () => {
  it("reads each roster session's W since the week began at the team's rate and its hours with work, in the roster's order", () => {
    const summary = sessionsWeekOf(input());
    assert.deepEqual(summary, {
      resetsAt: WINDOW.reset,
      at: NOW,
      sessions: { lead: { usedPct: 5, workHours: 2 }, alpha: { usedPct: 10, workHours: 3 }, bravo: { usedPct: 0, workHours: 0 } },
    });
    assert.deepEqual(Object.keys(summary?.sessions ?? {}), ['lead', 'alpha', 'bravo']);
  });

  it('counts no W and no hour from before the week began, its first hour whole', () => {
    const byId = new Map([['alpha', used({ '2030-01-06T20': 900_000_000, '2030-01-07T00': 30_000_000, '2030-01-07T01': 10_000_000 })]]);
    assert.deepEqual(sessionsWeekOf(input({ byId }))?.sessions, { alpha: { usedPct: 1, workHours: 1 } });
  });

  it('rounds the percents to hundredths and the time down to the minute', () => {
    const summary = sessionsWeekOf(input({ wPerPct: 3_000_000, now: NOW + 59_999 }));
    assert.equal(summary?.at, NOW);
    assert.equal(summary?.sessions['lead']?.usedPct, 16.67);
    assert.equal(summary?.sessions['alpha']?.usedPct, 33.33);
  });

  it('reads nothing while the week or the rate is unknown', () => {
    assert.equal(sessionsWeekOf(input({ window: undefined })), undefined);
    assert.equal(sessionsWeekOf(input({ wPerPct: undefined })), undefined);
    assert.equal(sessionsWeekOf(input({ wPerPct: 0 })), undefined);
  });
});

describe('workHoursSince', () => {
  it('counts the hours from the first to now with any W, never an empty one or one after now', () => {
    const state = used({ '2030-01-07T00': 1, '2030-01-07T01': 1, '2030-01-07T02': 0, '2030-01-08T10': 1, '2030-01-08T11': 1 });
    assert.equal(workHoursSince(state, WINDOW.start, NOW), 2);
    assert.equal(workHoursSince(EMPTY_USAGE, WINDOW.start, NOW), 0);
  });
});

describe('keepSessionsWeek', () => {
  const summary = { resetsAt: WINDOW.reset, at: NOW, sessions: { lead: { usedPct: 5, workHours: 2 } } };

  it('writes the summary, and again only when it changes', async () => {
    const files = new MemoryFiles();
    assert.equal(await keepSessionsWeek(files, PATH, summary), true);
    assert.deepEqual(parseSessionsWeek((await files.read(PATH)) ?? ''), summary);
    assert.equal(await keepSessionsWeek(files, PATH, summary), false, 'the same summary is not written again');
    assert.equal(await keepSessionsWeek(files, PATH, { ...summary, sessions: { lead: { usedPct: 5, workHours: 3 } } }), true);
    assert.equal(await files.read(PATH), formatSessionsWeek({ ...summary, sessions: { lead: { usedPct: 5, workHours: 3 } } }));
  });

  it('leaves a summary a newer teamrig wrote, past SESSIONS_WEEK_FORMAT, as it is, without failing', async () => {
    const files = new MemoryFiles();
    const newer = JSON.stringify({ v: SESSIONS_WEEK_FORMAT + 1, sessions: {} });
    await files.write(PATH, newer);
    assert.equal(await keepSessionsWeek(files, PATH, summary), false);
    assert.equal(await files.read(PATH), newer);
  });
});
