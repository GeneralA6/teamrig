import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET } from '../config/defaults.ts';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_WEEK } from '../core/time.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { ACCOUNT_SCOPE, calibrationOf, MeterLog, type LoggedReading, type MeterReading } from './calibration.ts';
import { ExtraLog, type ExtraEntry } from './extra.ts';
import { emptyPatterns } from './patterns.ts';
import { formatPeriod, parsePeriod, type Period } from './period.ts';
import type { WeekUse } from './snapshot.ts';
import type { UsageState } from './store.ts';
import { teamWeekOf, type WeekFiles } from './team-week.ts';
import { readWeek } from './week.ts';

const PATHS = { period: '/team/state/usage/period.json', meterLog: '/team/state/usage/meter-log.jsonl', extraLog: '/team/state/usage/extra-log.jsonl' };
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

/** The week files of an account the root team keeps. */
const ROOT_KEEPS: WeekFiles = { paths: PATHS, keeper: 'root' };

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
    const week = await teamWeekOf(files, ROOT_KEEPS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: STATES });
    const moved = parsePeriod((await files.read(PATHS.period)) ?? '');
    assert.deepEqual(moved, { ...stored, lastPct: 20, lastAt: STATUS.at });
    assert.deepEqual(week, { ...readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: stored, states: STATES, calibration: NOTHING_LEARNED, readings: [] }), limits: [] });
    const logged: LoggedReading = { at: STATUS.at, usedPct: 20, start: START, end: END, w: 1_000, forecastPct: undefined, scope: ACCOUNT_SCOPE };
    assert.deepEqual(await new MeterLog(files, PATHS.meterLog).read(NOW), [logged]);
  });

  it('logs nothing while the status line stays within the percent last read', async () => {
    const files = new MemoryFiles();
    await storedAt(files, 20);
    await teamWeekOf(files, ROOT_KEEPS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: STATES });
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
    const week = await teamWeekOf(files, ROOT_KEEPS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: STATES });
    assert.deepEqual([week.wPerPct, week.rateFrom, week.calibration.fit?.readings], [100, 'learned', 2]);
    assert.equal((await log.read(NOW)).at(-1)?.forecastPct, 10);
  });

  it("reads today's use between the period's meter log readings, and prices today's W at that use", async () => {
    const files = new MemoryFiles();
    const log = new MeterLog(files, PATHS.meterLog);
    const period = { start: START, end: END, forecastPct: undefined };
    // 14% at 500 W, 20% at 1,000 W: the 600 W before today read 15.2%, the 1,000 W now 20%, whatever the rate.
    await log.append({ ...period, at: NOW - 20 * MS_PER_HOUR, usedPct: 14, w: 500 }, NOW);
    await log.append({ ...period, at: STATUS.at, usedPct: 20, w: 1_000 }, NOW);
    const stored = await storedAt(files, 20);
    const week = await teamWeekOf(files, ROOT_KEEPS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: STATES });
    const readings = await log.read(NOW);
    assert.deepEqual(week, { ...readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: stored, states: STATES, calibration: calibrationOf(readings), readings }), limits: [] });
    assert.deepEqual([week.teamDay?.usedPct.toFixed(6), week.todayWPerPct?.toFixed(6)], [(4.8).toFixed(6), (400 / 4.8).toFixed(6)]);
  });

  it('reads the week without a period while no reset is known, and writes none', async () => {
    // The default budget sets no reset, and with no status line nothing shows one.
    const files = new MemoryFiles();
    const week = await teamWeekOf(files, ROOT_KEEPS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: undefined, states: STATES });
    assert.deepEqual([await files.read(PATHS.period), await files.read(PATHS.meterLog)], [undefined, undefined]);
    assert.deepEqual(week, { ...readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: undefined, period: undefined, states: STATES, calibration: NOTHING_LEARNED, readings: [] }), limits: [] });
  });

  it("reads the extra-usage pool past 100% from the extra log and the meter log's 100% line", async () => {
    const files = new MemoryFiles();
    const full: MeterReading = { at: NOW - 2 * MS_PER_HOUR, usedPct: 100, start: START, end: END, w: 900, forecastPct: undefined };
    await new MeterLog(files, PATHS.meterLog).append(full, NOW);
    const added: ExtraEntry = { at: NOW - MS_PER_HOUR, kind: 'add', usd: 10, weekPct: 100, start: START, end: END, w: 950 };
    await new ExtraLog(files, PATHS.extraLog).append(added);
    const stored = await storedAt(files, 100);
    const budget = { ...DEFAULT_BUDGET, extraWPerUsd: 50 };
    const status: WeekUse = { ...STATUS, usedPct: 100 };
    const week = await teamWeekOf(files, ROOT_KEEPS, { budget, now: NOW, statusUse: status, states: STATES });
    // 1,000 W metered, 100 W past the 100% line at 50 W per dollar: $2 of the $10 spent, 400 W left.
    assert.deepEqual(week.pool, { addedUsd: 10, spentUsd: 2, leftUsd: 8, wPerUsd: 50, learned: false, leftW: 400 });
    const expected = readWeek({ budget, now: NOW, statusUse: status, period: stored, states: STATES, calibration: calibrationOf([full]), readings: [full], extra: { entries: [added], wAtFull: 900 } });
    assert.deepEqual(week, { ...expected, limits: [{ start: full.at, end: END }] });
    // 10 W per percent from the status line: the pool's 40% over the 132 hours to the pace end, a 24-hour day of it.
    assert.equal(week.allowancePct?.toFixed(6), ((40 * 24) / 132).toFixed(6));
  });

  it('counts the 100% crossing this reading logged: the account stops there, so no later hook may come (T2050)', async () => {
    const files = new MemoryFiles();
    await storedAt(files, 99);
    const status: WeekUse = { ...STATUS, usedPct: 100 };
    const week = await teamWeekOf(files, ROOT_KEEPS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: status, states: STATES });
    assert.deepEqual(week.limits, [{ start: status.at, end: END }]);
  });
});

describe('teamWeekOf on an account several teams share (T1778)', () => {
  /** The app's stores sum 1,100 W since the week's start, where the root's (`STATES`) sum 1,000. */
  const APP_STATES = [state({ '2026-10-14': 700, '2026-10-15': 400 })];
  /** Every store on the account, as each team's reader passes them: its own, the use in no team, each peer's sessions. */
  const ACCOUNT_STATES = [...APP_STATES, ...STATES];
  const LAST = { start: START - MS_PER_WEEK, end: START, forecastPct: undefined };

  it('logs a crossing once, as one account line with the W of every store on the account', async () => {
    const files = new MemoryFiles();
    await storedAt(files, 15);
    await teamWeekOf(files, ROOT_KEEPS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: ACCOUNT_STATES });
    const line: LoggedReading = { at: STATUS.at, usedPct: 20, start: START, end: END, w: 2_100, forecastPct: undefined, scope: ACCOUNT_SCOPE };
    assert.deepEqual(await new MeterLog(files, PATHS.meterLog).read(NOW), [line]);
    // The period moved on: the next read, whichever team's, logs nothing more.
    await teamWeekOf(files, ROOT_KEEPS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: ACCOUNT_STATES });
    assert.deepEqual(await new MeterLog(files, PATHS.meterLog).read(NOW), [line]);
  });

  it("fits the keeper's own lines of a period before any account line, never another team's, and forecasts the account's W", async () => {
    const files = new MemoryFiles();
    const log = new MeterLog(files, PATHS.meterLog);
    // Last week the root's lines read 100 W per percent and the app's 110: both teams' together would fit about 105.
    const early = { ...LAST, at: START - 6 * MS_PER_DAY, usedPct: 5 };
    const late = { ...LAST, at: START - 2 * MS_PER_DAY, usedPct: 16 };
    await log.appendAll([{ ...early, w: 500, team: 'root' }, { ...early, w: 550, team: 'app' }, { ...late, w: 1_600, team: 'root' }, { ...late, w: 1_760, team: 'app' }], NOW);
    await storedAt(files, 15);
    const week = await teamWeekOf(files, ROOT_KEEPS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: ACCOUNT_STATES });
    assert.deepEqual([week.wPerPct, week.rateFrom, week.calibration.fit?.readings], [100, 'learned', 2]);
    const logged = (await log.read(NOW)).slice(4).map((reading) => [reading.scope, reading.w, reading.forecastPct]);
    assert.deepEqual(logged, [[ACCOUNT_SCOPE, 2_100, 21]]);
  });

  it("reads today's use between the account's lines only, dropping a team's line an older teamrig logged after them", async () => {
    const files = new MemoryFiles();
    const log = new MeterLog(files, PATHS.meterLog);
    const period = { start: START, end: END, forecastPct: undefined };
    // The account metered 500 W at 14% and 1,000 W at 20%; tabs on an older teamrig logged 17% between with their own W.
    const between = { ...period, at: NOW - 10 * MS_PER_HOUR, usedPct: 17 };
    await log.appendAll(
      [
        { ...period, at: NOW - 20 * MS_PER_HOUR, usedPct: 14, w: 500, scope: ACCOUNT_SCOPE },
        { ...between, w: 300, team: 'root' },
        { ...between, w: 200, team: 'app' },
        { ...period, at: STATUS.at, usedPct: 20, w: 1_000, scope: ACCOUNT_SCOPE },
      ],
      NOW,
    );
    const stored = await storedAt(files, 20);
    const week = await teamWeekOf(files, ROOT_KEEPS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: STATES });
    const account = (await log.read(NOW)).filter((reading) => reading.scope === ACCOUNT_SCOPE);
    assert.deepEqual(week, { ...readWeek({ budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, period: stored, states: STATES, calibration: calibrationOf(account), readings: account }), limits: [] });
    // The 600 W before today read 15.2% between the account's lines, the 1,000 W now 20%: the W-based day.
    assert.deepEqual([week.teamDay?.usedPct.toFixed(6), week.todayWPerPct?.toFixed(6)], [(4.8).toFixed(6), (400 / 4.8).toFixed(6)]);
  });

  it("reads the account's stretches at its limit from every line of the log, a team's too (T2050)", async () => {
    const files = new MemoryFiles();
    const full = START - MS_PER_DAY;
    await new MeterLog(files, PATHS.meterLog).append({ ...LAST, at: full, usedPct: 100, w: 9_000, team: 'app' }, NOW);
    await storedAt(files, 20);
    const week = await teamWeekOf(files, ROOT_KEEPS, { budget: DEFAULT_BUDGET, now: NOW, statusUse: STATUS, states: STATES });
    assert.deepEqual(week.limits, [{ start: full, end: START }]);
  });
});
