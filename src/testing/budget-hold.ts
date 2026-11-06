import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MeterLog } from '../budget/calibration.ts';
import { emptyPatterns } from '../budget/patterns.ts';
import { EMPTY_USAGE, UsageStore, type DayUsage } from '../budget/store.ts';
import type { JsonRecord } from '../core/guards.ts';
import { APP, TEAM_HOME, USER_HOME, type CliHarness } from './cli-harness.ts';
import { ok } from './hired-team.ts';
import { MemoryTranscripts } from './memory-transcripts.ts';
import { replyLine, transcript } from './transcript-lines.ts';

/** A budget on which 1% of the week is 10M W, and alpha's share a tenth of the lead's and bravo's. */
export const HOLDING_BUDGET: JsonRecord = { enabled: true, weeklyLimitW: 1_000_000_000, overAction: 'ask-lead', sessions: { alpha: { share: 0.1 } } };

/** The harness clock is Tuesday 2030-01-08 10:00 UTC; this week resets on Monday 2030-01-14 01:00 UTC. */
const RESET = Date.parse('2030-01-14T01:00:00Z');
/** The week began the day before the harness clock, Monday 2030-01-07 01:00 UTC. */
const WEEK_START = Date.parse('2030-01-07T01:00:00Z');
const PROJECT = join(USER_HOME, '.claude', 'projects', 'app');
const USAGE = join(TEAM_HOME, 'state', 'usage');
const ALPHA_W = 100_000_000;
const LEAD_W = 50_000_000;
/** The tab a spec's status line comes from when no session's tab matters to it. */
const STATUS_TAB = '0000000d-0000-4000-8000-000000000004';

/** The status line's stdin from `tab`, the week `usedPct` used. */
function statusOf(tab: string | undefined, usedPct: number): string {
  return JSON.stringify({ session_id: tab, cwd: APP, workspace: { current_dir: APP }, rate_limits: { seven_day: { used_percentage: usedPct, resets_at: RESET / 1000 } } });
}

function dayOf(w: number): DayUsage {
  return { w, calls: 1, patterns: emptyPatterns() };
}

/** A session's tab metered at `w` W today. */
export interface MeteredTab {
  readonly id: string;
  readonly tab: string;
  readonly w: number;
}

/**
 * Meters each tab at its W today, in a team on {@link HOLDING_BUDGET} at the harness clock: each tab becomes its
 * session's, the status line (from the first tab) has the week 30% used, so the team's daily budget is 12.4% of the
 * week and its in-day pace 5.2%, and each tab's stop hook meters its transcript.
 */
export async function meterToday(kit: CliHarness, tabs: readonly MeteredTab[]): Promise<void> {
  const source = new MemoryTranscripts();
  for (const { id, tab, w } of tabs) {
    ok(await kit.run(['inbox', 'read', '--session', id], { env: { CLAUDE_CODE_SESSION_ID: tab } }));
    source.set(join(PROJECT, `${tab}.jsonl`), transcript([replyLine({ id: `${id}-1`, requestId: `q-${id}`, at: '2030-01-08T09:00:00.000Z', usage: { input: w } })]), kit.clock.now());
  }
  ok(await kit.run(['statusline'], { stdin: statusOf(tabs[0]?.tab, 30) }));
  for (const { tab } of tabs) {
    ok(await kit.run(['hook', 'stop'], { stdin: JSON.stringify({ session_id: tab, cwd: APP, transcript_path: join(PROJECT, `${tab}.jsonl`) }), transcripts: source }));
  }
}

/**
 * Holds alpha by its budget, in a team on {@link HOLDING_BUDGET} at the harness clock: the status line has the week
 * 30% used, so the team's daily budget is 12.4% of the week and its in-day pace 5.2%; alpha's tab `alphaTab` and the
 * lead's `leadTab` are metered at 100M and 50M W today ({@link meterToday}). That is 10% of the week for alpha, past any part its tenth
 * share reaches with a few tasks queued (4.4% with a p0 and a p1), and 15% for the team: no room today.
 */
export async function holdAlpha(kit: CliHarness, alphaTab: string, leadTab: string): Promise<void> {
  await meterToday(kit, [
    { id: 'alpha', tab: alphaTab, w: ALPHA_W },
    { id: 'lead', tab: leadTab, w: LEAD_W },
  ]);
}

/**
 * Puts `w` W on `task` in the stored usage of `session` today, under `dir` (the team's usage by default), with the week
 * known from a status line at 30%. It writes the store as a stop hook would, so a spec of a reader of it needs no transcript.
 */
export async function storeTaskSpend(kit: CliHarness, session: string, task: string, w: number, dir: string = USAGE): Promise<void> {
  const usage = new UsageStore(kit.files, dir);
  const day = '2030-01-08';
  assert.ok(await usage.save(session, { ...EMPTY_USAGE, byDay: { [day]: dayOf(w) }, byTask: { [day]: { [task]: w } } }, (await usage.load(session)).rev), 'usage saved');
  ok(await kit.run(['statusline'], { stdin: statusOf(STATUS_TAB, 30) }));
}

/**
 * A day dearer than its week, in the team at TEAM_HOME on a budget whose `weeklyLimitW` is 1,000M W (10M W per
 * percent): `session` (its tab `tab`) metered 80M W on the week's first day, when the meter log read 26%, and 20M W
 * today, then the status line at 30%. Today's 4 points over 20M W are 5M W per percent, while the week's rate stays
 * the limit's: the two readings, 4 points apart, are too close for a fit (FIT_SPREAD_PTS, budget/calibration.ts).
 */
export async function meterDearDay(kit: CliHarness, session: string, tab: string): Promise<void> {
  const usage = new UsageStore(kit.files, USAGE);
  const byDay = { '2030-01-07': dayOf(80_000_000), '2030-01-08': dayOf(20_000_000) };
  assert.ok(await usage.save(session, { ...EMPTY_USAGE, byDay }, (await usage.load(session)).rev), 'usage saved');
  const reading = { start: WEEK_START, end: RESET, at: Date.parse('2030-01-07T22:00:00Z'), usedPct: 26, w: 80_000_000, forecastPct: undefined };
  await new MeterLog(kit.files, join(USAGE, 'meter-log.jsonl')).append(reading, kit.clock.now());
  ok(await kit.run(['inbox', 'read', '--session', session], { env: { CLAUDE_CODE_SESSION_ID: tab } }));
  ok(await kit.run(['statusline'], { stdin: statusOf(tab, 30) }));
}
