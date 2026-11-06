import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MeterLog } from '../../budget/calibration.ts';
import { OUTSIDE_ID } from '../../budget/measure.ts';
import { emptyPatterns } from '../../budget/patterns.ts';
import { parseSessionsWeek, SESSIONS_WEEK_IN_STATE } from '../../budget/session-week-summary.ts';
import { EMPTY_USAGE, UsageStore } from '../../budget/store.ts';
import { parseTasksWeek, TASKS_WEEK_IN_STATE } from '../../budget/task-week-summary.ts';
import { parseTeamWeek, TEAM_WEEK_IN_STATE } from '../../budget/team-week-summary.ts';
import { HOLDING_BUDGET, meterToday } from '../../testing/budget-hold.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../../testing/cli-harness.ts';

const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
const LEAD_TAB = '0123abcd-0000-4000-8000-0000000000d4';
const SUMMARY = join(TEAM_HOME, 'state', ...TEAM_WEEK_IN_STATE);
const SESSIONS = join(TEAM_HOME, 'state', ...SESSIONS_WEEK_IN_STATE);
const TASKS = join(TEAM_HOME, 'state', ...TASKS_WEEK_IN_STATE);

describe('the budget hooks', () => {
  it("keep the team's week summary on its account: its own sessions' W at its rate, never the use outside it, and its part of what is left", async () => {
    const kit = new CliHarness({ ...TEAM, budget: { ...HOLDING_BUDGET, account: 'work' } });
    const outside = new UsageStore(kit.files, join(TEAM_HOME, 'state', 'usage', 'outside'));
    const outsideDay = { '2030-01-08': { w: 40_000_000, calls: 1, patterns: emptyPatterns() } };
    assert.ok(await outside.save(OUTSIDE_ID, { ...EMPTY_USAGE, byDay: outsideDay }, (await outside.load(OUTSIDE_ID)).rev), 'outside use saved');
    assert.equal(await kit.files.read(SUMMARY), undefined);
    await meterToday(kit, [
      { id: 'alpha', tab: ALPHA_TAB, w: 100_000_000 },
      { id: 'lead', tab: LEAD_TAB, w: 50_000_000 },
    ]);
    const text = await kit.files.read(SUMMARY);
    // 150M W at 10M W per percent; the team alone on the account plans all of the 69.5% left to the 99.5% target.
    assert.deepEqual(text === undefined ? undefined : parseTeamWeek(text), {
      account: 'work',
      usedPct: 15,
      plannedPct: 84.5,
      accountUsedPct: 30,
      resetsAt: Date.parse('2030-01-14T01:00:00Z'),
      at: kit.clock.now(),
      limits: [],
    });
  });

  it("keep the stretches the account's week sat at its usage limit in the team's week summary (T2050)", async () => {
    const kit = new CliHarness({ ...TEAM, budget: { ...HOLDING_BUDGET, account: 'work' } });
    const end = Date.parse('2030-01-07T01:00:00Z');
    const full = Date.parse('2030-01-06T08:00:00Z');
    const line = { at: full, usedPct: 100, start: Date.parse('2029-12-31T01:00:00Z'), end, w: 1_000_000_000, forecastPct: undefined };
    await new MeterLog(kit.files, join(TEAM_HOME, 'state', 'usage', 'meter-log.jsonl')).append(line, kit.clock.now());
    await meterToday(kit, [{ id: 'alpha', tab: ALPHA_TAB, w: 100_000_000 }]);
    const text = await kit.files.read(SUMMARY);
    assert.deepEqual(text === undefined ? undefined : parseTeamWeek(text)?.limits, [{ start: full, end }]);
  });

  it("keep each roster session's week: its W at the team's rate and its hours with work, an idle session at none", async () => {
    const kit = new CliHarness({ ...TEAM, budget: HOLDING_BUDGET });
    assert.equal(await kit.files.read(SESSIONS), undefined);
    await meterToday(kit, [
      { id: 'alpha', tab: ALPHA_TAB, w: 100_000_000 },
      { id: 'lead', tab: LEAD_TAB, w: 50_000_000 },
    ]);
    const text = await kit.files.read(SESSIONS);
    // Each tab's one reply, at 09:00 UTC today, at 10M W per percent.
    assert.deepEqual(text === undefined ? undefined : parseSessionsWeek(text), {
      resetsAt: Date.parse('2030-01-14T01:00:00Z'),
      at: kit.clock.now(),
      sessions: { lead: { usedPct: 5, workHours: 1 }, alpha: { usedPct: 10, workHours: 1 }, bravo: { usedPct: 0, workHours: 0 } },
    });
  });

  it("keep each task's spend at the team's rate, the use outside the sessions included (T2093)", async () => {
    const kit = new CliHarness({ ...TEAM, budget: HOLDING_BUDGET });
    const usage = join(TEAM_HOME, 'state', 'usage');
    const bravo = new UsageStore(kit.files, usage);
    assert.ok(await bravo.save('bravo', { ...EMPTY_USAGE, byTask: { '2030-01-08': { T7: 20_000_000 } } }, (await bravo.load('bravo')).rev), 'bravo saved');
    const outside = new UsageStore(kit.files, join(usage, 'outside'));
    assert.ok(await outside.save(OUTSIDE_ID, { ...EMPTY_USAGE, byTask: { '2030-01-08': { T7: 5_000_000, T8: 10_000_000 } } }, (await outside.load(OUTSIDE_ID)).rev), 'outside use saved');
    assert.equal(await kit.files.read(TASKS), undefined);
    await meterToday(kit, [{ id: 'alpha', tab: ALPHA_TAB, w: 100_000_000 }]);
    const text = await kit.files.read(TASKS);
    // At 10M W per percent.
    assert.deepEqual(text === undefined ? undefined : parseTasksWeek(text), { at: kit.clock.now(), spentPct: { T7: 2.5, T8: 1 } });
  });
});
