import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { Burst } from '../budget/burst.ts';
import { BurstLog } from '../budget/burst-log.ts';
import { MeterLog } from '../budget/calibration.ts';
import { formatConfig } from '../config/load.ts';
import type { Files } from '../core/files.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { ENV } from '../core/home.ts';
import { inboxLineOf } from '../inbox/inbox.ts';
import { lineHash } from '../inbox/line-hash.ts';
import type { RunRequest } from '../open/processes.ts';
import { SessionLog } from '../sessions/log.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { EXIT } from './runtime.ts';
import { IDLE_PASS_LOG_EVERY_MS } from './idle-pass-log.ts';
import { DAY_PROBE_RECHECK_MS, RESTART_RECHECK_MS } from './commands/hook-wake.ts';
import { GIVE_UP_MS } from '../refresh/restart.ts';
import type { RefreshState, RestartRequest } from '../refresh/state.ts';
import { RefreshStore } from '../refresh/store.ts';
import { claudeCredentialsPath, formatLoginMarker, LOGIN_PROBE_STALE_MS, LOGIN_RETRY_GAP_MS, loginMarkerPath, parseLoginMarker, type LoginMarker } from '../restore/login.ts';
import { dayProbePath, formatDayProbe, parseDayProbe, type DayProbe } from '../restore/day-probe.ts';
import type { RestoreEntry } from '../restore/entry.ts';
import { RestoreRegistry, restoreLogPath, restoreSessionsDir } from '../restore/registry.ts';
import { HOLDING_BUDGET, holdAlpha, meterDearDay, meterToday } from '../testing/budget-hold.ts';
import { APP, AUTO_RESTART_TEAM, CliHarness, EVENTS_PATH, KIT, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { holdFileLock } from '../testing/held-file-lock.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { teamConfigOf, teamHomeOf, teamInboxOf } from '../testing/team-tree.ts';
import { WakeAsks } from '../wake/asks.ts';
import { WakePrompts, type WakePrompt } from '../wake/prompts.ts';

const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
const OTHER_TAB = '0123abcd-0000-4000-8000-0000000000b9';
const LEAD_TAB = '0123abcd-0000-4000-8000-0000000000d4';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const WAKE_LOG = join(TEAM_HOME, 'state', 'wakes.jsonl');
const ALPHA_LOCK = join(TEAM_HOME, 'state', 'wake', 'alpha.lock');
const ASKS = join(TEAM_HOME, 'state', 'wake-asks');
/** What a waiting tab of the session watches: the register, and the session's asks folder. */
const watchOf = (id = 'alpha'): readonly string[] => [EVENTS_PATH, join(ASKS, id)];

function payload(extra: JsonRecord = {}, tab = ALPHA_TAB): string {
  return JSON.stringify({ session_id: tab, cwd: APP, ...extra });
}

function answerOf(result: CliResult): unknown {
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 1);
  return JSON.parse(result.stdout[0] ?? '');
}

/** A team whose `alpha` read its inbox from ALPHA_TAB, so that tab is alpha. */
async function teamWithAlphaTab(config: JsonRecord = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
  return kit;
}

function hand(kit: CliHarness, title: string, priority: string, by = 'lead'): Promise<CliResult> {
  return kit.run(['add', '--title', title, '--description', 'what and why', '--priority', priority, '--owner', 'alpha', '--session', by]);
}

function check(kit: CliHarness, transcripts = new MemoryTranscripts()): Promise<CliResult> {
  return kit.run(['hook', 'wake-check'], { stdin: payload(), transcripts });
}

/** Alpha with its handover written, waiting for its fresh start. */
const READY: RefreshState = { phase: 'ready', task: 'T1', at: '2026-01-01T00:00:00.000Z', tokens: 300_000, noticed: true, transcript: null, claudePid: 4100 };

/** The check (pid 7000) run through a shell by Claude Code (6900). */
const UNDER_CLAUDE = (): FakeSessionProcesses =>
  new FakeSessionProcesses(7000)
    .add({ pid: 7000, parentPid: 6900, name: 'bash.exe', commandLine: 'bash -c "node main.js hook wake-check"' })
    .add({ pid: 6900, parentPid: 1, name: 'claude.exe', commandLine: 'claude' });

/**
 * A team whose alpha has p1 work handed after its last check while its restart, asked for `request`'s tab twice the
 * give-up window ago, never came: the runner died. `ready`: alpha still waits for that fresh start.
 */
async function deadRestart(config: JsonRecord, request: Partial<RestartRequest> = {}, ready = true): Promise<{ readonly kit: CliHarness; readonly store: RefreshStore }> {
  const kit = await teamWithAlphaTab({ ...config, wake: { batchSeconds: 0 } });
  const store = new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
  await check(kit);
  const left = new Date(kit.clock.now() - 2 * GIVE_UP_MS).toISOString();
  await store.setRestart('alpha', { phase: 'pending', at: left, pid: 4100, claudeSession: ALPHA_TAB, transcript: null, cwd: null, supervised: true, effort: null, ...request });
  await store.setState('alpha', ready ? READY : { phase: 'refreshed', task: 'T1', at: left });
  await hand(kit, 'Fix the login', 'p1');
  return { kit, store };
}

function checkUnder(kit: CliHarness, processes: FakeProcesses, sessionProcesses = UNDER_CLAUDE()): Promise<CliResult> {
  return kit.run(['hook', 'wake-check'], { stdin: payload(), transcripts: new MemoryTranscripts(), processes, sessionProcesses });
}

/** The automatic restart on, and work woken for as soon as it is handed. */
const PARKED_TEAM: JsonRecord = { ...AUTO_RESTART_TEAM, wake: { batchSeconds: 0 } };

/**
 * A team whose alpha, past its first check, wrote its handover with no work to follow, so its Stop hook held the
 * restart back for work in `tab` (T1383). `ready`: alpha still waits for that fresh start.
 */
async function parkedRestart(config: JsonRecord, tab = ALPHA_TAB, ready = true): Promise<{ readonly kit: CliHarness; readonly store: RefreshStore }> {
  const kit = await teamWithAlphaTab(config);
  const store = new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
  await check(kit);
  const at = new Date(kit.clock.now()).toISOString();
  await store.setParked('alpha', { at, claudeSession: tab, transcript: null, cwd: null, supervised: true, effort: null });
  await store.setState('alpha', ready ? READY : { phase: 'refreshed', task: 'T1', at });
  return { kit, store };
}

/** The wake prompt kept for alpha's turn log (src/wake/prompts.ts). */
function keptPrompt(kit: CliHarness): Promise<WakePrompt | undefined> {
  return new WakePrompts(kit.files, join(TEAM_HOME, 'state', 'wake')).read('alpha');
}

async function logLines(kit: CliHarness, path = WAKE_LOG): Promise<unknown[]> {
  const text = (await kit.files.read(path)) ?? '';
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

describe('hook wake-check', () => {
  it('takes what is there at the first check, then wakes once for p1 work handed meanwhile, after the batch', async () => {
    const kit = await teamWithAlphaTab();
    await hand(kit, 'Old work', 'p1');
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: null });
    await hand(kit, 'Fix the login', 'p1');
    const start = kit.clock.now();
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: start + 120 * SECOND });
    kit.clock.advance(120 * SECOND);
    const transcripts = new MemoryTranscripts();
    transcripts.set(join(USER_HOME, '.claude', 'projects', 'work-app', `${ALPHA_TAB}.jsonl`), '{}\n', kit.clock.now() - 5 * MINUTE);
    const text =
      'New work was handed to you while this tab was idle: T2 "Fix the login" (p1). ' +
      'Start a work block (`teamrig start --session alpha`) and work your list in plan order. This wake costs at least about 27k W for the first call, warm cache; whole turns usually cost more.';
    assert.deepEqual(answerOf(await check(kit, transcripts)), { kind: 'wake', ids: ['T2'], text, toast: 'teamrig woke this tab for T2 (at least about 27k W for the first call, warm cache; whole turns usually cost more)' });
    assert.deepEqual(await logLines(kit), [
      { v: 1, at: new Date(kit.clock.now()).toISOString(), kind: 'wake', session: 'alpha', tab: ALPHA_TAB, ids: ['T2'], w: 27_000, cold: false },
    ]);
    assert.deepEqual(await keptPrompt(kit), { tab: ALPHA_TAB, text }, 'kept for the turn log');
    kit.clock.advance(60 * MINUTE);
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: null }, 'never twice for one task');
  });

  it('keeps no wake prompt with turnLog off', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, turnLog: { enabled: false } });
    await check(kit);
    await hand(kit, 'Fix the login', 'p1');
    await check(kit);
    kit.clock.advance(120 * SECOND);
    const woke = answerOf(await check(kit));
    assert.ok(isRecord(woke) && woke['kind'] === 'wake', 'it woke');
    assert.equal(await keptPrompt(kit), undefined);
  });

  it('never wakes for less urgent work by default, and wakes for p2 when wake.priority is 2, costed cold with no transcript', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { priority: 2, batchSeconds: 0 }, budget: { weeklyLimitW: 1_000_000_000 } });
    await check(kit);
    await hand(kit, 'Tidy the docs', 'p3');
    await hand(kit, 'Ship the page', 'p2');
    const woke = answerOf(await check(kit));
    assert.ok(typeof woke === 'object' && woke !== null && 'toast' in woke);
    assert.equal(woke.toast, 'teamrig woke this tab for T2 (at least about 210k W for the first call, cold, 0.02% of the week; whole turns usually cost more)');
    assert.deepEqual(await logLines(kit), [
      { v: 1, at: new Date(kit.clock.now()).toISOString(), kind: 'wake', session: 'alpha', tab: ALPHA_TAB, ids: ['T2'], w: 210_000, cold: true, weekPct: 0.021 },
    ]);
  });

  it('costs the wake at the W per percent learned from the meter log, ahead of budget.weeklyLimitW', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { priority: 2, batchSeconds: 0 }, budget: { weeklyLimitW: 1_000_000_000 } });
    const now = kit.clock.now();
    const log = new MeterLog(kit.files, join(TEAM_HOME, 'state', 'usage', 'meter-log.jsonl'));
    const period = { start: now - 24 * 60 * MINUTE, end: now + 6 * 24 * 60 * MINUTE, forecastPct: undefined };
    await log.append({ ...period, at: now - 120 * MINUTE, usedPct: 5, w: 100_000_000 }, now);
    await log.append({ ...period, at: now - 60 * MINUTE, usedPct: 15, w: 300_000_000 }, now);
    await check(kit);
    await hand(kit, 'Ship the page', 'p2');
    const woke = answerOf(await check(kit));
    assert.ok(typeof woke === 'object' && woke !== null && 'toast' in woke);
    assert.equal(woke.toast, 'teamrig woke this tab for T1 (at least about 210k W for the first call, cold, 0.01% of the week; whole turns usually cost more)');
    assert.deepEqual(await logLines(kit), [
      { v: 1, at: new Date(kit.clock.now()).toISOString(), kind: 'wake', session: 'alpha', tab: ALPHA_TAB, ids: ['T1'], w: 210_000, cold: true, weekPct: 0.0105 },
    ]);
  });

  it("costs the wake at its own team's lines of the meter log, never another team's on the account (T1669)", async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { priority: 2, batchSeconds: 0 }, budget: { weeklyLimitW: 1_000_000_000 } });
    const now = kit.clock.now();
    const log = new MeterLog(kit.files, join(TEAM_HOME, 'state', 'usage', 'meter-log.jsonl'));
    const period = { start: now - 24 * 60 * MINUTE, end: now + 6 * 24 * 60 * MINUTE, forecastPct: undefined };
    for (const [team, wPerPct] of [['web', 5_000_000], ['app', 20_000_000]] as const) {
      await log.append({ ...period, team, at: now - 120 * MINUTE, usedPct: 5, w: 5 * wPerPct }, now);
      await log.append({ ...period, team, at: now - 60 * MINUTE, usedPct: 15, w: 15 * wPerPct }, now);
    }
    await check(kit);
    await hand(kit, 'Ship the page', 'p2');
    const woke = answerOf(await check(kit));
    assert.ok(typeof woke === 'object' && woke !== null && 'toast' in woke);
    assert.equal(woke.toast, 'teamrig woke this tab for T1 (at least about 210k W for the first call, cold, 0.01% of the week; whole turns usually cost more)', "web's 5M W per percent would say 0.04%");
  });

  it("costs the wake at today's W per percent, as the budget table prices today's rows, on a day dearer than its week (T1138)", async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { priority: 2, batchSeconds: 0 }, budget: { weeklyLimitW: 1_000_000_000 } });
    await meterDearDay(kit, 'alpha', ALPHA_TAB);
    await check(kit);
    await hand(kit, 'Ship the page', 'p2');
    const woke = answerOf(await check(kit));
    assert.ok(typeof woke === 'object' && woke !== null && 'toast' in woke);
    assert.equal(woke.toast, 'teamrig woke this tab for T1 (at least about 210k W for the first call, cold, 0.04% of the week; whole turns usually cost more)', 'the week rate would say 0.02%');
    assert.deepEqual(await logLines(kit), [
      { v: 1, at: new Date(kit.clock.now()).toISOString(), kind: 'wake', session: 'alpha', tab: ALPHA_TAB, ids: ['T1'], w: 210_000, cold: true, weekPct: 0.042 },
    ]);
  });

  it('wakes for p1 only in quiet hours, whatever wake.priority says', async () => {
    const budget = { enabled: true, overAction: 'ask', quietHours: { startUtc: '09:00', endUtc: '11:00', action: 'ask' } };
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { priority: 2, batchSeconds: 0 }, budget });
    await check(kit);
    await hand(kit, 'Ship the page', 'p2');
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: null });
    await hand(kit, 'Fix the outage', 'p1');
    assert.equal((await check(kit)).stdout[0]?.includes('"kind":"wake","ids":["T2"]'), true);
  });

  it('wakes for p0 only in quiet hours that block, since a woken p1 turn chain would run on until the morning (T2504)', async () => {
    const budget = { enabled: true, overAction: 'ask', quietHours: { startUtc: '09:00', endUtc: '11:00', action: 'block' } };
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { priority: 2, batchSeconds: 0 }, budget });
    await check(kit);
    await hand(kit, 'Fix the outage', 'p1');
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: null });
    await hand(kit, 'Stop the outage', 'p0');
    assert.equal((await check(kit)).stdout[0]?.includes('"kind":"wake","ids":["T2"]'), true);
  });

  it('wakes for p0 only while its budget holds it, and for the work held back once the hold ends (T1159)', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { batchSeconds: 0 }, budget: HOLDING_BUDGET });
    await holdAlpha(kit, ALPHA_TAB, LEAD_TAB);
    await check(kit);
    await hand(kit, 'Ship the page', 'p1');
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: null }, 'the budget stop lets only p0 go on');
    await hand(kit, 'Stop the outage', 'p0');
    assert.equal((await check(kit)).stdout[0]?.includes('"kind":"wake","ids":["T2"]'), true);
    kit.clock.advance(24 * 60 * MINUTE);
    assert.equal((await check(kit)).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true, "a new day's budget ends the hold");
  });

  it("holds a session whose daily budget the wake's own turn would pass, though it spent nothing today (T1322)", async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { batchSeconds: 0 }, budget: { ...HOLDING_BUDGET, sessions: { alpha: { share: 0 } } } });
    await meterToday(kit, [{ id: 'lead', tab: LEAD_TAB, w: 150_000_000 }]);
    await check(kit);
    await hand(kit, 'Ship the page', 'p1');
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: null }, 'its budget of 0 has no room for the cold wake');
    kit.clock.advance(24 * 60 * MINUTE);
    assert.equal((await check(kit)).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true, "a new day's room ends the hold");
  });

  it("ignores the session's own task and work that waits on an unfinished task", async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { batchSeconds: 0 } });
    await check(kit);
    await hand(kit, 'My own idea', 'p1', 'alpha');
    await hand(kit, 'First step', 'p2');
    await kit.run(['add', '--title', 'Second step', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--after', 'T2', '--session', 'lead']);
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: null });
  });

  it("never wakes the lead while the owner's daily meeting is open, and wakes it for the work handed meanwhile after", async () => {
    const kit = new CliHarness();
    await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
    const leadCheck = () => kit.run(['hook', 'wake-check'], { stdin: payload() });
    await leadCheck();
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    await kit.run(['add', '--title', 'Decide the outage fix', '--description', 'what and why', '--priority', 'p1', '--owner', 'lead', '--session', 'alpha']);
    kit.clock.advance(10 * MINUTE);
    assert.deepEqual(answerOf(await leadCheck()), { kind: 'wait', watch: watchOf('lead'), recheckAt: null });
    assert.equal((await kit.run(['meeting', 'end', '--session', 'lead'])).code, EXIT.ok);
    const start = kit.clock.now();
    assert.deepEqual(answerOf(await leadCheck()), { kind: 'wait', watch: watchOf('lead'), recheckAt: start + 120 * SECOND });
    kit.clock.advance(120 * SECOND);
    assert.equal((await leadCheck()).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true);
  });

  it('never wakes a session while its automatic restart may act, whose prompt would cancel it, and wakes it for the work after (T980)', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { batchSeconds: 0 } });
    const store = new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
    const request: RestartRequest = { phase: 'pending', at: new Date(kit.clock.now()).toISOString(), pid: 4100, claudeSession: ALPHA_TAB, transcript: null, cwd: null, supervised: false, effort: null };
    await check(kit);
    await store.setRestart('alpha', request);
    await hand(kit, 'Fix the login', 'p1');
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: kit.clock.now() + RESTART_RECHECK_MS });
    await store.setRestart('alpha', { ...request, phase: 'ending' });
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: kit.clock.now() + RESTART_RECHECK_MS }, 'ending too');
    await store.clearRestart('alpha');
    assert.equal((await check(kit)).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true);
  });

  it('wakes a session whose restart request is older than any restart that could act on it, with the automatic restart off', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { batchSeconds: 0 } });
    const store = new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
    await check(kit);
    const left = new Date(kit.clock.now() - 2 * GIVE_UP_MS).toISOString();
    await store.setRestart('alpha', { phase: 'pending', at: left, pid: 4100, claudeSession: ALPHA_TAB, transcript: null, cwd: null, supervised: false, effort: null });
    await store.setState('alpha', READY);
    await hand(kit, 'Fix the login', 'p1');
    assert.equal((await check(kit)).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true);
  });

  it('wakes for an urgent line once it is a batch old, then logs and removes it', async () => {
    const kit = await teamWithAlphaTab();
    const asks = new WakeAsks(kit.files, ASKS);
    await check(kit);
    await asks.post('alpha', { from: 'teamrig', text: 'The idle pass closed bravo.', at: kit.clock.now() });
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: kit.clock.now() + 120 * SECOND });
    kit.clock.advance(120 * SECOND);
    const woke = answerOf(await check(kit));
    assert.ok(typeof woke === 'object' && woke !== null && 'text' in woke && 'toast' in woke && 'ids' in woke);
    assert.deepEqual(woke.ids, []);
    assert.match(String(woke.text), /^Urgent lines were posted for you while this tab was idle; act on each now:\n- \d\d:\d\d \w+ teamrig: The idle pass closed bravo\.\nThis wake costs at least about 210k W for the first call, cold; whole turns usually cost more\.$/);
    assert.equal(woke.toast, 'teamrig woke this tab for an urgent line from teamrig (at least about 210k W for the first call, cold; whole turns usually cost more)');
    assert.deepEqual(await logLines(kit), [{ v: 1, at: new Date(kit.clock.now()).toISOString(), kind: 'wake', session: 'alpha', tab: ALPHA_TAB, ids: [], w: 210_000, cold: true, asks: 1 }]);
    assert.deepEqual(await asks.read('alpha'), []);
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: null }, 'never twice for one line');
  });

  it('wakes for an urgent line and the work handed with it in one wake, and for the next line with no gap since', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { batchSeconds: 0 } });
    await check(kit);
    await hand(kit, 'Fix the login', 'p1');
    await new WakeAsks(kit.files, ASKS).post('alpha', { from: 'teamrig', text: 'The idle pass closed bravo.', at: kit.clock.now() });
    const woke = answerOf(await check(kit));
    assert.ok(typeof woke === 'object' && woke !== null && 'text' in woke && 'toast' in woke && 'ids' in woke);
    assert.deepEqual(woke.ids, ['T1']);
    assert.match(String(woke.text), /teamrig: The idle pass closed bravo\.\nNew work was handed to you while this tab was idle: T1 "Fix the login" \(p1\)\./);
    assert.equal(woke.toast, 'teamrig woke this tab for T1 and an urgent line from teamrig (at least about 210k W for the first call, cold; whole turns usually cost more)');
    await new WakeAsks(kit.files, ASKS).post('alpha', { from: 'bravo', text: 'Bravo has a reply waiting.', at: kit.clock.now() });
    assert.equal((await check(kit)).stdout[0]?.includes('"toast":"teamrig woke this tab for an urgent line from bravo'), true, 'wake.minGapMinutes holds no line');
  });

  it('wakes for a --wake-by line at its time while it is unseen, looking again then, and drops one read before', async () => {
    for (const read of [false, true]) {
      const kit = await teamWithAlphaTab();
      await check(kit);
      const text = 'Answer on T7.';
      assert.equal((await kit.run(['inbox', 'add', '--to', 'alpha', '--text', text, '--session', 'bravo'])).code, EXIT.ok);
      const at = kit.clock.now();
      const asks = new WakeAsks(kit.files, ASKS);
      await asks.post('alpha', { from: 'bravo', text, at, by: { at: at + 10 * MINUTE, line: lineHash(inboxLineOf(new Date(at), 'bravo', text)) } });
      assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: at + 10 * MINUTE });
      if (read) {
        assert.equal((await kit.run(['inbox', 'read', '--session', 'alpha'])).code, EXIT.ok);
      }
      kit.clock.advance(10 * MINUTE);
      const answer = answerOf(await check(kit));
      if (read) {
        assert.deepEqual(answer, { kind: 'wait', watch: watchOf(), recheckAt: null });
      } else {
        assert.ok(typeof answer === 'object' && answer !== null && 'toast' in answer);
        assert.equal(answer.toast, 'teamrig woke this tab for an urgent line from bravo (at least about 210k W for the first call, cold; whole turns usually cost more)');
      }
      assert.deepEqual(await asks.read('alpha'), [], `read: ${read}`);
    }
  });

  it("keeps an urgent line for the lead while the owner's daily meeting is open, and removes a damaged one", async () => {
    const kit = new CliHarness({ ...TEAM, wake: { batchSeconds: 0 } });
    await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
    const asks = new WakeAsks(kit.files, ASKS);
    await asks.post('lead', { from: 'teamrig', text: 'The idle pass closed bravo.', at: kit.clock.now() });
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    assert.deepEqual(answerOf(await kit.run(['hook', 'wake-check'], { stdin: payload() })), { kind: 'wait', watch: watchOf('lead'), recheckAt: null });
    assert.equal((await asks.read('lead')).length, 1);
    await kit.files.write(join(ASKS, 'lead', '1-0.json'), '{"v":1,"from":"teamrig"');
    assert.equal((await kit.run(['meeting', 'end', '--session', 'lead'])).code, EXIT.ok);
    assert.equal((await kit.run(['hook', 'wake-check'], { stdin: payload() })).stdout[0]?.includes('"toast":"teamrig woke this tab for an urgent line from teamrig'), true);
    assert.deepEqual(await asks.read('lead'), [], 'the damaged one goes with the ones the wake took');
  });

  it('starts a restart whose runner died again from its tab, for the Claude Code the check runs under, holding the wake (T1088)', async () => {
    const { kit, store } = await deadRestart(AUTO_RESTART_TEAM);
    const processes = new FakeProcesses();
    const underClaude = UNDER_CLAUDE();
    assert.deepEqual(answerOf(await checkUnder(kit, processes, underClaude)), { kind: 'wait', watch: watchOf(), recheckAt: kit.clock.now() + RESTART_RECHECK_MS });
    const at = new Date(kit.clock.now()).toISOString();
    assert.deepEqual(await store.restart('alpha'), { phase: 'pending', at, pid: 6900, claudeSession: ALPHA_TAB, transcript: null, cwd: null, supervised: true, effort: null });
    assert.deepEqual(underClaude.lineages, [7000], 'the Claude Code process looked up once');
    const runners = (): string[][] => processes.hidden.filter((run) => run.args[1] === 'restart').map((run) => [run.command, run.cwd, ...run.args]);
    // The request names no folder, so the new tab opens in the one the tab's check runs in.
    assert.deepEqual(runners(), [['/usr/bin/node', APP, '/opt/teamrig/dist/cli/main.js', 'restart', 'alpha', '--team', 'app', '--at', at, '--project', APP]]);

    kit.clock.advance(RESTART_RECHECK_MS);
    assert.deepEqual(answerOf(await checkUnder(kit, processes)), { kind: 'wait', watch: watchOf(), recheckAt: kit.clock.now() + RESTART_RECHECK_MS }, 'held by the new runner');
    assert.equal(runners().length, 1, 'started once');
  });

  it('leaves a restart whose runner died alone for another tab or a session no longer waiting for its fresh start, and wakes it', async () => {
    const cases: readonly { readonly name: string; readonly request: Partial<RestartRequest>; readonly ready: boolean }[] = [
      { name: 'asked for another tab', request: { claudeSession: OTHER_TAB }, ready: true },
      { name: 'the session refreshed since', request: {}, ready: false },
    ];
    for (const { name, request, ready } of cases) {
      const { kit, store } = await deadRestart(AUTO_RESTART_TEAM, request, ready);
      const processes = new FakeProcesses();
      const underClaude = UNDER_CLAUDE();
      assert.equal((await checkUnder(kit, processes, underClaude)).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true, name);
      assert.deepEqual([processes.hidden, underClaude.lineages], [[], []], `${name}: nothing started or looked up`);
      assert.equal((await store.restart('alpha'))?.at, new Date(kit.clock.now() - 2 * GIVE_UP_MS).toISOString(), `${name}: left as it was`);
    }
  });

  it('clears a restart whose runner died when it cannot start again, and wakes the session (T1088)', async () => {
    const failing = await deadRestart(AUTO_RESTART_TEAM);
    const missing = new FakeProcesses().onStart('/usr/bin/node', { kind: 'missing' });
    assert.equal((await checkUnder(failing.kit, missing)).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true);
    assert.deepEqual([await failing.store.restart('alpha'), missing.hidden.length], [undefined, 1]);

    const unseen = await deadRestart(AUTO_RESTART_TEAM);
    const processes = new FakeProcesses();
    assert.equal((await checkUnder(unseen.kit, processes, new FakeSessionProcesses(7000))).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true, 'no Claude Code found');
    assert.deepEqual([await unseen.store.restart('alpha'), processes.hidden], [undefined, []]);
  });

  it('starts a session whose restart waits for work fresh once work is handed, the work left to wake the fresh session (T1383)', async () => {
    const { kit, store } = await parkedRestart(PARKED_TEAM);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await checkUnder(kit, processes)), { kind: 'wait', watch: watchOf(), recheckAt: null }, 'no work: it waits');
    assert.deepEqual([processes.hidden, (await store.parked('alpha'))?.claudeSession], [[], ALPHA_TAB]);
    await hand(kit, 'Fix the login', 'p1');
    const underClaude = UNDER_CLAUDE();
    assert.deepEqual(answerOf(await checkUnder(kit, processes, underClaude)), { kind: 'wait', watch: watchOf(), recheckAt: kit.clock.now() + RESTART_RECHECK_MS });
    const at = new Date(kit.clock.now()).toISOString();
    assert.deepEqual(await store.restart('alpha'), { phase: 'pending', at, pid: 6900, claudeSession: ALPHA_TAB, transcript: null, cwd: null, supervised: true, effort: null });
    assert.deepEqual([await store.parked('alpha'), underClaude.lineages, await logLines(kit)], [undefined, [7000], []], 'armed once, no wake logged');
    const runners = processes.hidden.filter((run) => run.args[1] === 'restart').map((run) => [run.command, run.cwd, ...run.args]);
    assert.deepEqual(runners, [['/usr/bin/node', APP, '/opt/teamrig/dist/cli/main.js', 'restart', 'alpha', '--team', 'app', '--at', at, '--project', APP]]);

    // The restart's /clear: the fresh session is woken for the work.
    await store.clearRestart('alpha');
    await store.setState('alpha', { phase: 'refreshed', task: 'T1', at });
    assert.equal((await check(kit)).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true);
  });

  it('keeps an urgent line for the fresh start of a session whose restart waits for work (T1383)', async () => {
    const { kit, store } = await parkedRestart(PARKED_TEAM);
    const asks = new WakeAsks(kit.files, ASKS);
    await asks.post('alpha', { from: 'teamrig', text: 'The idle pass closed bravo.', at: kit.clock.now() });
    assert.deepEqual(answerOf(await checkUnder(kit, new FakeProcesses())), { kind: 'wait', watch: watchOf(), recheckAt: kit.clock.now() + RESTART_RECHECK_MS });
    assert.deepEqual([(await store.restart('alpha'))?.phase, (await asks.read('alpha')).length], ['pending', 1]);
  });

  it('leaves a restart held back for work alone for another tab or with the automatic restart off, drops it once the session refreshed, and wakes it (T1383)', async () => {
    const cases: readonly { readonly name: string; readonly config: JsonRecord; readonly tab: string; readonly ready: boolean; readonly left: boolean }[] = [
      { name: 'held back for another tab', config: PARKED_TEAM, tab: OTHER_TAB, ready: true, left: true },
      { name: 'the automatic restart off', config: { ...TEAM, wake: { batchSeconds: 0 } }, tab: ALPHA_TAB, ready: true, left: true },
      { name: 'the session refreshed since', config: PARKED_TEAM, tab: ALPHA_TAB, ready: false, left: false },
    ];
    for (const { name, config, tab, ready, left } of cases) {
      const { kit, store } = await parkedRestart(config, tab, ready);
      await hand(kit, 'Fix the login', 'p1');
      const processes = new FakeProcesses();
      const underClaude = UNDER_CLAUDE();
      assert.equal((await checkUnder(kit, processes, underClaude)).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true, name);
      assert.deepEqual([processes.hidden, underClaude.lineages], [[], []], `${name}: nothing started or looked up`);
      assert.equal((await store.parked('alpha')) !== undefined, left, `${name}: ${left ? 'left' : 'dropped'}`);
    }
  });

  it('wakes the session for the work with its context when the restart held back for work cannot start (T1383)', async () => {
    const { kit, store } = await parkedRestart(PARKED_TEAM);
    await hand(kit, 'Fix the login', 'p1');
    const missing = new FakeProcesses().onStart('/usr/bin/node', { kind: 'missing' });
    assert.equal((await checkUnder(kit, missing)).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true);
    assert.deepEqual([await store.restart('alpha'), await store.parked('alpha'), missing.hidden.length], [undefined, undefined, 1]);
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: null }, 'woken once');
  });

  it('answers a recheck now while another tab of the session holds its lock', async () => {
    const kit = await teamWithAlphaTab();
    await holdFileLock(kit, ALPHA_LOCK);
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: watchOf(), recheckAt: kit.clock.now() });
  });

  it('fails on any other error under the lock', async () => {
    const kit = await teamWithAlphaTab();
    const files = new FaultyFiles(kit.files).fail('write', join(TEAM_HOME, 'state', 'wake', 'alpha.json'), systemError('EACCES'));
    const failed = await kit.run(['hook', 'wake-check'], { stdin: payload(), files });
    assert.equal(failed.code, EXIT.failed);
    assert.deepEqual(failed.stdout, []);
    assert.equal(await kit.files.read(ALPHA_LOCK), undefined, 'the lock is let go');
  });

  it('is off outside a team, with wake off, for a tab that is no team session, and with no session id', async () => {
    const off = (why: string) => ({ kind: 'off', why });
    assert.deepEqual(answerOf(await check(new CliHarness(TEAM, null))), off('not in a team'));
    assert.deepEqual(answerOf(await check(new CliHarness('{"sessions":'))), off('the team config does not load'));
    assert.deepEqual(answerOf(await check(await teamWithAlphaTab({ ...TEAM, wake: { enabled: false } }))), off('wake.enabled is false'));
    const kit = await teamWithAlphaTab();
    assert.deepEqual(answerOf(await kit.run(['hook', 'wake-check'], { stdin: payload({}, OTHER_TAB) })), off('this tab is not a team session'));
    assert.deepEqual(answerOf(await kit.run(['hook', 'wake-check'], { stdin: '{}' })), off('no session id'));
  });
});

describe('hook wake-check at the day start and a burst', () => {
  const DAY = 24 * 60 * MINUTE;
  const DAY_START = { ...TEAM, wake: { dayStartUtc: '06:00' } };
  const BURSTS = join(TEAM_HOME, 'state', 'usage', 'bursts.jsonl');
  const ALPHA_TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${ALPHA_TAB}.jsonl`);
  /** The harness's clock starts at 2030-01-08 10:00 UTC, so today's 06:00 has passed: the next day start is tomorrow's. */
  const TOMORROW_SIX = Date.parse('2030-01-09T06:00:00.000Z');
  const waitTill = (recheckAt: number | null) => ({ kind: 'wait', watch: watchOf(), recheckAt });

  function turnAt(at: number): MemoryTranscripts {
    const transcripts = new MemoryTranscripts();
    transcripts.set(ALPHA_TRANSCRIPT, '{}\n', at);
    return transcripts;
  }

  function startBurst(kit: CliHarness, sessions: readonly string[]): Promise<void> {
    const at = kit.clock.now();
    const burst: Burst = { kind: 'surplus', sessions, helpers: 2, hires: 0, dailyPct: 2.5, stopPct: 99.5, endsAt: at + DAY, tasks: [], reason: 'surplus', by: 'lead', at };
    return new BurstLog(kit.files, BURSTS).append(burst);
  }

  it('wakes an idle session once at the day start for work of any priority, never again that day in any tab, and again the next day', async () => {
    const kit = await teamWithAlphaTab(DAY_START);
    await hand(kit, 'Tidy the docs', 'p3');
    assert.deepEqual(answerOf(await check(kit)), {
      kind: 'wake',
      ids: ['T1'],
      text:
        'The day started at 06:00 UTC and this tab has had no turn since. Work you can start: T1 "Tidy the docs" (p3). ' +
        'Start a work block (`teamrig start --session alpha`) and work your list in plan order. This wake costs at least about 210k W for the first call, cold; whole turns usually cost more.',
      toast: 'teamrig woke this tab for the day start: T1 (at least about 210k W for the first call, cold; whole turns usually cost more)',
    });
    assert.deepEqual(await logLines(kit), [
      { v: 1, at: new Date(kit.clock.now()).toISOString(), kind: 'wake', session: 'alpha', tab: ALPHA_TAB, ids: ['T1'], w: 210_000, cold: true, moments: ['day-start'] },
    ]);
    kit.clock.advance(60 * MINUTE);
    assert.deepEqual(answerOf(await check(kit)), waitTill(TOMORROW_SIX), 'never twice a day');
    await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: OTHER_TAB } });
    const otherCheck = () => kit.run(['hook', 'wake-check'], { stdin: payload({}, OTHER_TAB) });
    assert.deepEqual(answerOf(await otherCheck()), waitTill(TOMORROW_SIX), 'nor in a new tab of the session');
    kit.clock.advance(TOMORROW_SIX - kit.clock.now());
    assert.match((await otherCheck()).stdout[0] ?? '', /"toast":"teamrig woke this tab for the day start: T1 \(at least about 210k W for the first call, cold; whole turns usually cost more\)"/);
  });

  it('starts a session whose restart waits for work fresh at the day start, the day start left to wake the fresh session (T1383)', async () => {
    const { kit, store } = await parkedRestart({ ...DAY_START, refresh: { autoRestart: true } });
    await hand(kit, 'Tidy the docs', 'p3');
    assert.deepEqual(answerOf(await checkUnder(kit, new FakeProcesses())), waitTill(kit.clock.now() + RESTART_RECHECK_MS));
    assert.equal((await store.restart('alpha'))?.phase, 'pending');
    await store.clearRestart('alpha');
    await store.setState('alpha', { phase: 'refreshed', task: 'T1', at: new Date(kit.clock.now()).toISOString() });
    assert.match((await check(kit)).stdout[0] ?? '', /"toast":"teamrig woke this tab for the day start: T1 /);
  });

  it('settles the day start with no wake for a tab that had a turn after it', async () => {
    const kit = await teamWithAlphaTab(DAY_START);
    await hand(kit, 'Ship the page', 'p2');
    assert.deepEqual(answerOf(await check(kit, turnAt(kit.clock.now() - 60 * MINUTE))), waitTill(TOMORROW_SIX));
    assert.deepEqual(answerOf(await check(kit)), waitTill(TOMORROW_SIX), 'settled for the day');
    assert.deepEqual(await logLines(kit), []);
  });

  it('keeps the day start due while the session has no work it can start, and wakes it once it has some', async () => {
    const kit = await teamWithAlphaTab(DAY_START);
    assert.deepEqual(answerOf(await check(kit)), waitTill(TOMORROW_SIX));
    await hand(kit, 'Ship the page', 'p2');
    assert.match((await check(kit)).stdout[0] ?? '', /"toast":"teamrig woke this tab for the day start: T1 /);
  });

  it('keeps the day start due through quiet hours and wakes once they end', async () => {
    const budget = { enabled: true, overAction: 'ask', quietHours: { startUtc: '09:30', endUtc: '11:00', action: 'ask' } };
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { dayStartUtc: '09:00' }, budget });
    await hand(kit, 'Ship the page', 'p2');
    assert.deepEqual(answerOf(await check(kit)), waitTill(Date.parse('2030-01-09T09:00:00.000Z')));
    kit.clock.advance(60 * MINUTE);
    assert.match((await check(kit)).stdout[0] ?? '', /"toast":"teamrig woke this tab for the day start: T1 /);
  });

  it('wakes a session in a burst once the burst starts, and not one outside it', async () => {
    const kit = await teamWithAlphaTab(DAY_START);
    await hand(kit, 'Ship the page', 'p2');
    const turned = turnAt(kit.clock.now() - 60 * MINUTE);
    assert.deepEqual(answerOf(await check(kit, turned)), waitTill(TOMORROW_SIX));
    await startBurst(kit, ['bravo']);
    assert.deepEqual(answerOf(await check(kit, turned)), waitTill(TOMORROW_SIX));
    kit.clock.advance(MINUTE);
    await startBurst(kit, ['alpha', 'bravo']);
    const woke = (await check(kit, turned)).stdout[0] ?? '';
    assert.match(woke, /"text":"The lead started a surplus burst until .*: app-alpha's daily budget is at least 2\.5%, up to 2 helpers at once\. Work you can start: T1/);
    assert.match(woke, /"toast":"teamrig woke this tab for the burst: T1 \(at least about 210k W for the first call, cold; whole turns usually cost more\)"/);
    kit.clock.advance(60 * MINUTE);
    assert.deepEqual(answerOf(await check(kit)), waitTill(TOMORROW_SIX), 'once per burst');
  });

  it("leaves the day start due for a session whose budget the wake's own turn would pass, and wakes it on a day with room (T1322)", async () => {
    const kit = await teamWithAlphaTab({ ...DAY_START, budget: { ...HOLDING_BUDGET, sessions: { alpha: { share: 0 } } } });
    // The lead used 15% of the week today, past the team's in-day pace of 5.2%: no room; alpha used nothing.
    await meterToday(kit, [{ id: 'lead', tab: LEAD_TAB, w: 150_000_000 }]);
    await hand(kit, 'Ship the page', 'p2');
    assert.deepEqual(answerOf(await check(kit)), waitTill(TOMORROW_SIX), 'held: a budget of 0 has no room for the cold wake');
    assert.deepEqual(await logLines(kit), []);
    kit.clock.advance(TOMORROW_SIX - kit.clock.now());
    assert.match((await check(kit)).stdout[0] ?? '', /"toast":"teamrig woke this tab for the day start: T1 /, "a new day's room ends the hold");
  });

  it('lets a wake for handed work go first, then waits out the gap before the day start', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { dayStartUtc: '06:00', batchSeconds: 0 } });
    await check(kit);
    await hand(kit, 'Fix the outage', 'p1');
    assert.match((await check(kit)).stdout[0] ?? '', /"text":"New work was handed to you while this tab was idle: T1/);
    assert.deepEqual(answerOf(await check(kit)), waitTill(kit.clock.now() + 15 * MINUTE));
  });
});

describe("hook wake-check at the day schedule's start (T2000)", () => {
  const DAY_START = { ...TEAM, wake: { dayStartUtc: '06:00' } };
  const SCHEDULE = join(TEAM_HOME, 'state', 'day-schedule.json');
  const waitTill = (recheckAt: number | null) => ({ kind: 'wait', watch: watchOf(), recheckAt });

  function schedule(kit: CliHarness, days: Readonly<Record<string, Readonly<Record<string, string>>>>): Promise<void> {
    return kit.files.write(SCHEDULE, `${JSON.stringify({ v: 1, days })}\n`);
  }

  it("wakes no one on a day the schedule gives the team none, over the team's configured start, and wakes at the next scheduled start", async () => {
    const kit = await teamWithAlphaTab(DAY_START);
    await schedule(kit, { '2030-01-08': { app: 'none' }, '2030-01-09': { app: '07:00' } });
    await hand(kit, 'Tidy the docs', 'p3');
    const tomorrowSeven = Date.parse('2030-01-09T07:00:00.000Z');
    assert.deepEqual(answerOf(await check(kit)), waitTill(tomorrowSeven));
    assert.deepEqual(await logLines(kit), []);
    kit.clock.advance(tomorrowSeven - kit.clock.now());
    assert.match((await check(kit)).stdout[0] ?? '', /"toast":"teamrig woke this tab for the day start: T1 /);
  });

  it('waits for a start the schedule sets later today, then wakes the session once', async () => {
    const kit = await teamWithAlphaTab(DAY_START);
    await schedule(kit, { '2030-01-08': { app: '12:00' } });
    await hand(kit, 'Tidy the docs', 'p3');
    const noon = Date.parse('2030-01-08T12:00:00.000Z');
    assert.deepEqual(answerOf(await check(kit)), waitTill(noon));
    kit.clock.advance(noon - kit.clock.now());
    assert.match((await check(kit)).stdout[0] ?? '', /"toast":"teamrig woke this tab for the day start: T1 /);
    assert.deepEqual(answerOf(await check(kit)), waitTill(Date.parse('2030-01-09T12:00:00.000Z')), 'the day repeats until the next written one');
  });

  it("takes the session's own start over its team's, for a team with no configured day start too", async () => {
    const kit = await teamWithAlphaTab(TEAM);
    await schedule(kit, { '2030-01-08': { app: '12:00', 'app/alpha': '08:00' } });
    await hand(kit, 'Tidy the docs', 'p3');
    assert.match((await check(kit)).stdout[0] ?? '', /"toast":"teamrig woke this tab for the day start: T1 /);
  });
});

describe('hook wake-check runs the idle pass', () => {
  const STATE = join(TEAM_HOME, 'state');
  const PASS_LOG = join(STATE, 'idle-pass.jsonl');
  const PASS_STATE = join(STATE, 'idle-pass.json');
  const SESSION_LOG = join(STATE, 'session-log.jsonl');
  const DRY_RUN: JsonRecord = { ...TEAM, open: { idle: { mode: 'dry-run' } } };
  const ON: JsonRecord = { ...TEAM, open: { idle: { mode: 'on' } } };
  const COMMIT = { usedMb: 85_300, limitMb: 100_700 };
  const WAIT = { kind: 'wait', watch: watchOf(), recheckAt: null };

  /** A dry-run team whose bravo the lead closed at 09:00 UTC; neither lead nor alpha runs. */
  async function idleTeam(config: JsonRecord = DRY_RUN): Promise<CliHarness> {
    const kit = await teamWithAlphaTab(config);
    await new SessionLog(kit.files, SESSION_LOG).append({ kind: 'close', session: 'bravo', by: 'lead', at: '2030-01-08T09:00:00.000Z', claudeSession: 'claude-bravo', idleMinutes: 75, freedMb: 1300 });
    return kit;
  }

  /** Alpha's tab's wake check, over `files`, starting hidden programs through `processes`, with `folders` on disk. */
  function passCheck(
    kit: CliHarness,
    { files = kit.files, processes = new FakeProcesses(), folders = [APP] }: { readonly files?: Files; readonly processes?: FakeProcesses; readonly folders?: readonly string[] } = {},
  ): Promise<CliResult> {
    return kit.run(['hook', 'wake-check'], { stdin: payload(), files, processes, probe: new FakePathProbe({ folders }), memory: new FakeHostMemory().lists([], COMMIT) });
  }

  /** The lead hands bravo a p1, which the wake check would wake bravo for. */
  async function handBravo(kit: CliHarness): Promise<void> {
    const handed = await kit.run(['add', '--title', 'Ship the page', '--description', 'what and why', '--priority', 'p1', '--owner', 'bravo', '--session', 'lead']);
    assert.equal(handed.code, 0, handed.stderr.join('\n'));
  }

  const pass = (at: number, steps: readonly JsonRecord[], mode = 'dry-run'): JsonRecord => ({ v: 1, at: new Date(at).toISOString(), kind: 'pass', mode, commit: COMMIT, steps: [...steps] });
  const AWAY_LEAD = { kind: 'away', id: 'lead', line: 'AWAY app-lead (session lead): not running, and teamrig did not close it' };
  const AWAY_ALPHA = { kind: 'away', id: 'alpha', line: 'AWAY app-alpha (session alpha): not running, and teamrig did not close it' };
  const CLOSED_BRAVO = { kind: 'closed', id: 'bravo', line: 'CLOSED app-bravo (session bravo): nothing it can start' };
  const REOPEN_BRAVO = { kind: 'reopen', id: 'bravo', line: 'REOPEN app-bravo (session bravo): work handed to it since its close: T1' };

  it('runs once a minute across the team in dry-run, logging only the steps whose kind changed, and the wake answer stands', async () => {
    const kit = await idleTeam();
    const processes = new FakeProcesses();
    const first = kit.clock.now();
    assert.deepEqual(answerOf(await passCheck(kit, { processes })), WAIT);
    assert.deepEqual(await logLines(kit, PASS_LOG), [pass(first, [AWAY_LEAD, AWAY_ALPHA, CLOSED_BRAVO])]);
    await handBravo(kit);
    kit.clock.advance(30 * SECOND);
    await passCheck(kit, { processes });
    assert.equal((await logLines(kit, PASS_LOG)).length, 1, 'once a minute');
    kit.clock.advance(30 * SECOND);
    await passCheck(kit, { processes });
    assert.deepEqual(await logLines(kit, PASS_LOG), [pass(first, [AWAY_LEAD, AWAY_ALPHA, CLOSED_BRAVO]), pass(kit.clock.now(), [REOPEN_BRAVO])]);
    kit.clock.advance(MINUTE);
    await passCheck(kit, { processes });
    assert.equal((await logLines(kit, PASS_LOG)).length, 2, 'a pass that changed nothing logs nothing');
    assert.equal((await logLines(kit, SESSION_LOG)).length, 1, 'and dry-run reopens nothing');
    assert.deepEqual(processes.hidden, [], 'nor starts a reopen');
  });

  it('logs every step again once its last pass record is an hour old, though no kind changed (T1158)', async () => {
    const kit = await idleTeam();
    const first = kit.clock.now();
    await passCheck(kit);
    kit.clock.advance(IDLE_PASS_LOG_EVERY_MS - MINUTE);
    await passCheck(kit);
    assert.equal((await logLines(kit, PASS_LOG)).length, 1, 'a quiet pass inside the hour logs nothing');
    kit.clock.advance(MINUTE);
    await passCheck(kit);
    const steps = [AWAY_LEAD, AWAY_ALPHA, CLOSED_BRAVO];
    assert.deepEqual(await logLines(kit, PASS_LOG), [pass(first, steps), pass(kit.clock.now(), steps)]);
  });

  it('in mode on starts the reopen hidden, starts none on its session for 5 minutes, then starts it again', async () => {
    const kit = await idleTeam(ON);
    const processes = new FakeProcesses();
    await passCheck(kit, { processes });
    assert.deepEqual(processes.hidden, [], 'a closed session with nothing to start stays closed');
    await handBravo(kit);
    kit.clock.advance(MINUTE);
    assert.deepEqual(answerOf(await passCheck(kit, { processes })), WAIT);
    const started = kit.clock.now();
    const reopen = { command: '/usr/bin/node', args: ['/opt/teamrig/dist/cli/main.js', 'idle-open', 'bravo', '--team', 'app', '--project', APP], cwd: APP };
    assert.deepEqual(
      processes.hidden.map(({ command, args, cwd }) => ({ command, args, cwd })),
      [reopen],
    );
    const state: unknown = JSON.parse(kit.files.get(PASS_STATE) ?? '');
    assert.deepEqual(state, { v: 1, at: started, kinds: { lead: 'away', alpha: 'away', bravo: 'reopen' }, logged: started, pending: { bravo: { act: 'reopen', at: started } } });
    kit.clock.advance(4 * MINUTE);
    await passCheck(kit, { processes });
    assert.equal(processes.hidden.length, 1, 'held while its reopen may still run');
    kit.clock.advance(MINUTE);
    await passCheck(kit, { processes });
    assert.equal(processes.hidden.length, 2, 'started again once the hold ran out and its step still asks for it');
  });

  it('in mode on logs a reopen that did not start, and holds its session as for one that did', async () => {
    const kit = await idleTeam(ON);
    await handBravo(kit);
    const processes = new FakeProcesses().onStart('/usr/bin/node', { kind: 'missing' });
    const at = kit.clock.now();
    await passCheck(kit, { processes });
    const failed = { v: 1, at: new Date(at).toISOString(), kind: 'act', mode: 'on', act: 'reopen', id: 'bravo', outcome: 'failed', line: 'FAILED to start the reopen of app-bravo (session bravo): node was not found' };
    assert.deepEqual(await logLines(kit, PASS_LOG), [pass(at, [AWAY_LEAD, AWAY_ALPHA, REOPEN_BRAVO], 'on'), failed]);
    kit.clock.advance(MINUTE);
    await passCheck(kit, { processes });
    assert.equal(processes.hidden.length, 1);
  });

  it("in mode on starts the reopen in the session's own launch.<id>.project folder", async () => {
    const own = resolve('/', 'work', 'bravo');
    const kit = await idleTeam({ ...ON, launch: { bravo: { project: own } } });
    await handBravo(kit);
    const processes = new FakeProcesses();
    await passCheck(kit, { processes, folders: [APP, own] });
    assert.deepEqual(
      processes.hidden.map(({ args, cwd }) => ({ args: args.slice(-2), cwd })),
      [{ args: ['--project', own], cwd: own }],
    );
  });

  it('in mode on leaves for later, starting nothing, the reopen of a session whose launch.<id>.project is no folder', async () => {
    const gone = resolve('/', 'work', 'gone');
    const kit = await idleTeam({ ...ON, launch: { bravo: { project: gone } } });
    await handBravo(kit);
    const processes = new FakeProcesses();
    const at = kit.clock.now();
    await passCheck(kit, { processes });
    const later = { kind: 'later', id: 'bravo', line: `LATER app-bravo (session bravo): work handed to it since its close: T1; the project folder ${gone} does not exist` };
    assert.deepEqual(await logLines(kit, PASS_LOG), [pass(at, [AWAY_LEAD, AWAY_ALPHA, later], 'on')]);
    assert.deepEqual(processes.hidden, []);
  });

  it('logs a failed pass once until its error changes, keeps the wake answer, and logs every step once it runs through', async () => {
    const kit = await idleTeam();
    const faulty = new FaultyFiles(kit.files).fail('read', SESSION_LOG, systemError('EACCES', 'EACCES: permission denied'));
    const first = kit.clock.now();
    assert.deepEqual(answerOf(await passCheck(kit, { files: faulty })), WAIT);
    kit.clock.advance(MINUTE);
    assert.deepEqual(answerOf(await passCheck(kit, { files: faulty })), WAIT);
    const failed = { v: 1, at: new Date(first).toISOString(), kind: 'failed', mode: 'dry-run', error: 'EACCES: permission denied' };
    assert.deepEqual(await logLines(kit, PASS_LOG), [failed]);
    kit.clock.advance(MINUTE);
    await passCheck(kit);
    assert.deepEqual(await logLines(kit, PASS_LOG), [failed, pass(kit.clock.now(), [AWAY_LEAD, AWAY_ALPHA, CLOSED_BRAVO])]);
  });

  it('names once a reopened tab no teamrig hook started in, to the lead with a wake in mode on, and drops the mark once a hook started', async () => {
    for (const mode of ['dry-run', 'on'] as const) {
      const kit = await idleTeam(mode === 'on' ? ON : DRY_RUN);
      await new SessionLog(kit.files, SESSION_LOG).append({ kind: 'reopen', session: 'bravo', at: new Date(kit.clock.now()).toISOString(), resumed: 'claude-bravo' });
      kit.clock.advance(5 * MINUTE);
      await passCheck(kit);
      const line = 'HOOKLESS app-bravo (session bravo): reopened 01-08 10:00 UTC, and no teamrig hook has started in its tab in the 5 min since, so it gets no inbox, guards or tab status: /exit that tab and run claude --resume claude-bravo in its terminal';
      const hookless = { v: 1, at: new Date(kit.clock.now()).toISOString(), kind: 'hookless', mode, id: 'bravo', line };
      const hooklessLines = async (): Promise<unknown[]> => (await logLines(kit, PASS_LOG)).filter((record) => JSON.stringify(record).includes('"kind":"hookless"'));
      assert.deepEqual(await hooklessLines(), [hookless], mode);
      const asks = (await new WakeAsks(kit.files, ASKS).read('lead')).map((stored) => stored.ask?.text);
      assert.deepEqual(asks, mode === 'on' ? [line] : [], `${mode}: only mode on wakes the lead`);
      kit.clock.advance(MINUTE);
      await passCheck(kit);
      assert.deepEqual(await hooklessLines(), [hookless], `${mode}: told once a reopen`);
      await new SessionRecordStore(kit.files, { sessions: join(STATE, 'sessions') }).write('bravo', { claudePid: 8200, claudeSession: 'claude-bravo', at: new Date(kit.clock.now()).toISOString() });
      kit.clock.advance(MINUTE);
      await passCheck(kit);
      assert.deepEqual(await hooklessLines(), [hookless], `${mode}: a hook started`);
      const state: unknown = JSON.parse(kit.files.get(PASS_STATE) ?? '');
      assert.equal(JSON.stringify(state).includes('told'), false, `${mode}: its mark dropped`);
    }
  });

  it("in mode on names a reopened lead tab to the delivery owner on a team above, with a wake there (T1143)", async () => {
    const kit = await idleTeam({ ...ON, team: { id: 'app', parent: 'root' }, roles: { lead: 'lead', deliveryOwner: 'root/po' } });
    await kit.files.write(teamConfigOf('root'), formatConfig({ configVersion: 1, team: { id: 'root' }, sessions: ['lead', 'po'], roles: { lead: 'lead', deliveryOwner: 'po' } }));
    await new SessionLog(kit.files, SESSION_LOG).append({ kind: 'reopen', session: 'lead', at: new Date(kit.clock.now()).toISOString(), resumed: 'claude-lead' });
    kit.clock.advance(5 * MINUTE);
    await passCheck(kit);
    const line = 'HOOKLESS app-lead (session app/lead): reopened 01-08 10:00 UTC, and no teamrig hook has started in its tab in the 5 min since, so it gets no inbox, guards or tab status: /exit that tab and run claude --resume claude-lead in its terminal';
    const asksOf = async (dir: string, id: string): Promise<unknown[]> => (await new WakeAsks(kit.files, dir).read(id)).map((stored) => stored.ask?.text);
    assert.deepEqual(await asksOf(join(teamHomeOf('root'), 'state', 'wake-asks'), 'po'), [line]);
    assert.ok((kit.files.get(teamInboxOf('root', 'po')) ?? '').includes(` app/teamrig: ${line}`), "root's po has the line in its inbox, from app's teamrig");
    assert.deepEqual(await asksOf(ASKS, 'lead'), [], "the child's own lead is not woken for its own hookless tab");
  });

  it("skips the pass while another tab's check holds its lock, and reads nothing with open.idle.mode off", async () => {
    const kit = await idleTeam();
    await holdFileLock(kit, join(STATE, 'idle-pass.lock'));
    assert.deepEqual(answerOf(await passCheck(kit)), WAIT);
    const off = await idleTeam({ ...TEAM, open: { idle: { mode: 'off' } } });
    const unreadable = new FaultyFiles(off.files).fail('read', PASS_STATE, systemError('EACCES'));
    assert.deepEqual(answerOf(await passCheck(off, { files: unreadable })), WAIT);
    for (const team of [kit, off]) {
      assert.equal(team.files.get(PASS_LOG), undefined);
      assert.equal(team.files.get(PASS_STATE), undefined);
    }
  });
});

describe('hook wake-dropped', () => {
  it('logs a dropped wake with its reason and forgets its prompt, and nothing for a tab that is no team session', async () => {
    const kit = await teamWithAlphaTab();
    const prompts = new WakePrompts(kit.files, join(TEAM_HOME, 'state', 'wake'));
    await prompts.remember('alpha', { tab: ALPHA_TAB, text: 'New work was handed to you.' });
    const dropped = await kit.run(['hook', 'wake-dropped'], { stdin: payload({ reason: 'blocked by a hook' }) });
    assert.equal(await keptPrompt(kit), undefined, 'a later typed prompt is never taken for it');
    assert.deepEqual(dropped, { code: 0, stdout: [], stderr: [] });
    await kit.run(['hook', 'wake-dropped'], { stdin: payload() });
    await kit.run(['hook', 'wake-dropped'], { stdin: payload({ reason: 'x' }, OTHER_TAB) });
    const at = new Date(kit.clock.now()).toISOString();
    assert.deepEqual(await logLines(kit), [
      { v: 1, at, kind: 'dropped', session: 'alpha', tab: ALPHA_TAB, reason: 'blocked by a hook' },
      { v: 1, at, kind: 'dropped', session: 'alpha', tab: ALPHA_TAB, reason: 'no reason given' },
    ]);
  });
});

const MARKER = loginMarkerPath(KIT);
const CREDENTIALS = claudeCredentialsPath({}, USER_HOME);
const FAIL_AT = Date.parse('2030-01-08T09:30:00.000Z');
const RECOVERED_AT = Date.parse('2030-01-08T09:55:00.000Z');
/** What a tab stuck on an expired login watches: the default, then the login marker and the credentials file. */
const stuckWatchOf = (id = 'alpha'): readonly string[] => [...watchOf(id), MARKER, CREDENTIALS];

/** A login marker whose `stranded` tabs ended their turns on Login expired at FAIL_AT; `recoveredAt` once a good turn proved the login. */
function stuckMarker(stranded: readonly string[], recoveredAt: number | undefined): LoginMarker {
  return {
    expiredAt: FAIL_AT,
    lastFailAt: FAIL_AT,
    recoveredAt,
    stranded: new Map(stranded.map((tab) => [tab, FAIL_AT])),
    pagedAt: FAIL_AT,
    probe: undefined,
    lastRetryAt: undefined,
    retried: new Map(),
  };
}

/** A team whose alpha is ALPHA_TAB and bravo OTHER_TAB, with `marker` as the kit home's login marker. */
async function stuckTeam(marker: LoginMarker, config: JsonRecord = TEAM): Promise<CliHarness> {
  const kit = await teamWithAlphaTab(config);
  await kit.run(['inbox', 'read', '--session', 'bravo'], { env: { CLAUDE_CODE_SESSION_ID: OTHER_TAB } });
  await kit.files.write(MARKER, formatLoginMarker(marker));
  return kit;
}

function checkTab(kit: CliHarness, tab: string): Promise<CliResult> {
  return kit.run(['hook', 'wake-check'], { stdin: payload({}, tab), transcripts: new MemoryTranscripts() });
}

async function loginMarkerOf(kit: CliHarness): Promise<LoginMarker | undefined> {
  const text = await kit.files.read(MARKER);
  return text === undefined ? undefined : parseLoginMarker(text);
}

/** The restore log's login lines, each without its time. */
async function restoreLoginLines(kit: CliHarness): Promise<string[]> {
  const text = (await kit.files.read(restoreLogPath(KIT))) ?? '';
  return text
    .split('\n')
    .filter((line) => line.includes(' login: '))
    .map((line) => line.slice(line.indexOf(' ') + 1));
}

/** A stuck tab's retry as the check answers it: `sign` is what says the login works, the cost a cold turn's. */
function retryAnswer(session: string, sign: string): unknown {
  return {
    kind: 'wake',
    ids: [],
    text:
      `Your last turn ended on Login expired at 09:30 UTC; ${sign}. ` +
      `Go on with that turn's work (if a wake started it: \`teamrig start --session ${session}\`). This retry costs at least about 210k W for the first call, cold; whole turns usually cost more.`,
    toast: `teamrig retried this tab's turn that ended on Login expired: ${sign} (at least about 210k W for the first call, cold; whole turns usually cost more)`,
  };
}

function idsOf(answer: unknown): unknown {
  return isRecord(answer) ? answer['ids'] : undefined;
}

describe('hook wake-check login retry', () => {
  it('sends a stuck tab on once a good turn proved the login, logs the retry, then waits on the login', async () => {
    const kit = await stuckTeam(stuckMarker([ALPHA_TAB], RECOVERED_AT));
    const now = kit.clock.now();
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), retryAnswer('alpha', 'the login works again'));
    assert.deepEqual(await logLines(kit), [{ v: 1, at: new Date(now).toISOString(), kind: 'wake', session: 'alpha', tab: ALPHA_TAB, ids: [], w: 210_000, cold: true, retry: 'login' }]);
    assert.deepEqual(await restoreLoginLines(kit), [`login: retried app/alpha (${ALPHA_TAB}), the login works again`]);
    const marker = await loginMarkerOf(kit);
    assert.deepEqual([marker?.retried.get(ALPHA_TAB), marker?.lastRetryAt, marker?.probe], [now, now, undefined]);
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), { kind: 'wait', watch: stuckWatchOf(), recheckAt: null }, 'once per sign');
  });

  it('comes before handed work, which wakes the tab at its next check; a tab the marker does not hold wakes as before', async () => {
    const kit = await stuckTeam(stuckMarker([OTHER_TAB], RECOVERED_AT), { ...TEAM, wake: { batchSeconds: 0 } });
    await checkTab(kit, ALPHA_TAB);
    const untouched = await kit.files.read(MARKER);
    await hand(kit, 'Fix the login', 'p1');
    assert.deepEqual(idsOf(answerOf(await checkTab(kit, ALPHA_TAB))), ['T1']);
    assert.equal(await kit.files.read(MARKER), untouched, 'nothing claimed for a tab that is not stuck');
    // Past wake.minGapMinutes: a retry recorded as a wake would hold the next one for as long again.
    kit.clock.advance(15 * MINUTE);
    await kit.files.write(MARKER, formatLoginMarker(stuckMarker([ALPHA_TAB], RECOVERED_AT)));
    await hand(kit, 'Fix the logout', 'p1');
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), retryAnswer('alpha', 'the login works again'));
    assert.deepEqual(idsOf(answerOf(await checkTab(kit, ALPHA_TAB))), ['T2'], 'the retry took nothing from the wake state');
  });

  it('tests a renewed login with one stuck tab while it is still expired; the others wait for it, or until it goes stale', async () => {
    const kit = await stuckTeam(stuckMarker([ALPHA_TAB, OTHER_TAB], undefined));
    const before = await kit.files.read(MARKER);
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), { kind: 'wait', watch: stuckWatchOf(), recheckAt: null }, 'no credentials file: no sign yet');
    assert.equal(await kit.files.read(MARKER), before);
    kit.clock.advance(MINUTE);
    await kit.files.write(CREDENTIALS, '{}');
    const probeAt = kit.clock.now();
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), retryAnswer('alpha', 'the login was renewed since'));
    assert.deepEqual((await loginMarkerOf(kit))?.probe, { tab: ALPHA_TAB, at: probeAt });
    assert.deepEqual(answerOf(await checkTab(kit, OTHER_TAB)), { kind: 'wait', watch: stuckWatchOf('bravo'), recheckAt: probeAt + LOGIN_PROBE_STALE_MS });
    kit.clock.advance(LOGIN_PROBE_STALE_MS);
    assert.deepEqual(answerOf(await checkTab(kit, OTHER_TAB)), retryAnswer('bravo', 'the login was renewed since'), 'a probe with no result frees the slot');
    assert.deepEqual(await restoreLoginLines(kit), [
      `login: retried app/alpha (${ALPHA_TAB}), which tests the renewed login`,
      `login: retried app/bravo (${OTHER_TAB}), which tests the renewed login`,
    ]);
  });

  it('spaces the retries of the tabs one expiry stranded once the login works', async () => {
    const kit = await stuckTeam(stuckMarker([ALPHA_TAB, OTHER_TAB], RECOVERED_AT));
    const first = kit.clock.now();
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), retryAnswer('alpha', 'the login works again'));
    assert.deepEqual(answerOf(await checkTab(kit, OTHER_TAB)), { kind: 'wait', watch: stuckWatchOf('bravo'), recheckAt: first + LOGIN_RETRY_GAP_MS });
    kit.clock.advance(LOGIN_RETRY_GAP_MS);
    assert.deepEqual(answerOf(await checkTab(kit, OTHER_TAB)), retryAnswer('bravo', 'the login works again'));
    assert.deepEqual((await logLines(kit)).map((line) => (isRecord(line) ? line['session'] : undefined)), ['alpha', 'bravo']);
  });

  it("answers a recheck now while another tab's check holds the login marker's lock, claiming nothing", async () => {
    const kit = await stuckTeam(stuckMarker([ALPHA_TAB], RECOVERED_AT));
    const before = await kit.files.read(MARKER);
    await holdFileLock(kit, `${MARKER}.lock`);
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), { kind: 'wait', watch: watchOf(), recheckAt: kit.clock.now() });
    assert.equal(await kit.files.read(MARKER), before);
    assert.deepEqual(await logLines(kit), []);
  });
});

function alphaEntryOf(kit: CliHarness): Promise<RestoreEntry | undefined> {
  return new RestoreRegistry(kit.files, restoreSessionsDir(KIT)).read(ALPHA_TAB);
}

/** Writes ALPHA_TAB's restore entry: its last turn ended at `failedAt` on `code`, with `retries` retries sent since. */
async function failedTab(kit: CliHarness, failedAt: number, code: string, retries = 0): Promise<void> {
  const entry: RestoreEntry = {
    claudeSession: ALPHA_TAB,
    projectDir: APP,
    transcriptPath: join(USER_HOME, '.claude', 'projects', 'app', `${ALPHA_TAB}.jsonl`),
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: 6000,
    team: 'app',
    session: 'alpha',
    state: 'error',
    createdAt: failedAt - 60 * MINUTE,
    updatedAt: failedAt,
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: undefined,
    endReason: undefined,
    apiError: { code, failedAt, retries, retriedAt: retries === 0 ? undefined : failedAt },
  };
  await new RestoreRegistry(kit.files, restoreSessionsDir(KIT)).write(entry);
}

/** The restore log's API error lines, each without its time. */
async function restoreApiLines(kit: CliHarness): Promise<string[]> {
  const text = (await kit.files.read(restoreLogPath(KIT))) ?? '';
  return text
    .split('\n')
    .filter((line) => line.includes(' api-error: '))
    .map((line) => line.slice(line.indexOf(' ') + 1));
}

/** Alpha's retry `n` after its turn ended on `code` at `failedAt` (UTC), the cost a cold turn's. */
function apiRetryAnswer(code: string, n: number, failedAt: string): unknown {
  return {
    kind: 'wake',
    ids: [],
    text:
      `Your last turn ended on an API error (${code}) at ${failedAt} UTC; retry ${n} of 3. ` +
      "Go on with that turn's work (if a wake started it: `teamrig start --session alpha`). This retry costs at least about 210k W for the first call, cold; whole turns usually cost more.",
    toast: `teamrig retried this tab's turn that ended on an API error (${code}), ${n} of 3 (at least about 210k W for the first call, cold; whole turns usually cost more)`,
  };
}

describe('hook wake-check API error retry', () => {
  it('sends on a turn that ended on a transient API error a minute after it failed, logs the retry, then waits 5 minutes', async () => {
    const kit = await teamWithAlphaTab();
    const failedAt = kit.clock.now();
    await failedTab(kit, failedAt, 'server_error');
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), { kind: 'wait', watch: watchOf(), recheckAt: failedAt + MINUTE });
    kit.clock.advance(MINUTE);
    const now = kit.clock.now();
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), apiRetryAnswer('server_error', 1, '10:00'));
    assert.deepEqual(await logLines(kit), [{ v: 1, at: new Date(now).toISOString(), kind: 'wake', session: 'alpha', tab: ALPHA_TAB, ids: [], w: 210_000, cold: true, retry: 'api' }]);
    assert.deepEqual(await restoreApiLines(kit), [`api-error: retried app/alpha (${ALPHA_TAB}), its turn ended on server_error; retry 1 of 3`]);
    assert.deepEqual((await alphaEntryOf(kit))?.apiError, { code: 'server_error', failedAt, retries: 1, retriedAt: now });
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), { kind: 'wait', watch: watchOf(), recheckAt: now + 5 * MINUTE });
  });

  it('leaves a tab after its last retry, and never retries a rate limit', async () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['server_error', 3],
      ['rate_limit', 0],
    ];
    for (const [code, retries] of cases) {
      const kit = await teamWithAlphaTab();
      await failedTab(kit, kit.clock.now() - 60 * MINUTE, code, retries);
      const before = await alphaEntryOf(kit);
      assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), { kind: 'wait', watch: watchOf(), recheckAt: null }, code);
      assert.deepEqual(await alphaEntryOf(kit), before, `${code}: nothing claimed`);
      assert.deepEqual(await logLines(kit), [], code);
    }
  });

  it('keeps the login retry first for a tab the login marker holds', async () => {
    const kit = await stuckTeam(stuckMarker([ALPHA_TAB], RECOVERED_AT));
    await failedTab(kit, FAIL_AT, 'server_error');
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), retryAnswer('alpha', 'the login works again'));
    assert.equal((await alphaEntryOf(kit))?.apiError?.retries, 0, 'no API retry spent on it');
  });

  it('comes before handed work, which wakes the tab at its next check', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { batchSeconds: 0 } });
    await failedTab(kit, kit.clock.now(), 'overloaded');
    await checkTab(kit, ALPHA_TAB);
    await hand(kit, 'Fix the outage', 'p1');
    kit.clock.advance(MINUTE);
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), apiRetryAnswer('overloaded', 1, '10:00'));
    assert.deepEqual(idsOf(answerOf(await checkTab(kit, ALPHA_TAB))), ['T1'], 'the retry took nothing from the wake state');
  });
});

describe('hook wake-check day start under the login', () => {
  const DAY_START = { ...TEAM, wake: { dayStartUtc: '06:00' } };
  const SIX = Date.parse('2030-01-08T06:00:00.000Z');
  /** The harness's clock starts at 2030-01-08 10:00 UTC, so today's 06:00 has passed: the next day start is tomorrow's. */
  const TOMORROW_SIX = Date.parse('2030-01-09T06:00:00.000Z');
  const PROBE_FILE = dayProbePath(KIT);
  const DAY_START_TOAST = /"toast":"teamrig woke this tab for the day start: T\d /;
  /** What a tab waiting for another tab's probe watches: the default, then the probe's file and the login marker. */
  const probeWatchOf = (id: string): readonly string[] => [...watchOf(id), PROBE_FILE, MARKER];

  async function probeOf(kit: CliHarness): Promise<DayProbe | undefined> {
    const text = await kit.files.read(PROBE_FILE);
    return text === undefined ? undefined : parseDayProbe(text);
  }

  /** The restore log's day-probe lines, each without its time. */
  async function probeLines(kit: CliHarness): Promise<string[]> {
    const text = (await kit.files.read(restoreLogPath(KIT))) ?? '';
    return text
      .split('\n')
      .filter((line) => line.includes(' day-probe: '))
      .map((line) => line.slice(line.indexOf(' ') + 1));
  }

  /** Alpha and bravo with work to start (p3: below `wake.priority`, so only the day start wakes for it), the login expired at FAIL_AT. */
  async function expiredTeam(): Promise<CliHarness> {
    const kit = await stuckTeam(stuckMarker([], undefined), DAY_START);
    await hand(kit, 'Tidy the docs', 'p3');
    await kit.run(['add', '--title', 'Tidy the guide', '--description', 'what and why', '--priority', 'p3', '--owner', 'bravo', '--session', 'lead']);
    return kit;
  }

  it('holds the day start while the login is expired, then has the first due tab test the renewed login while the next waits for its reply', async () => {
    const kit = await expiredTeam();
    assert.deepEqual(answerOf(await checkTab(kit, ALPHA_TAB)), { kind: 'wait', watch: stuckWatchOf(), recheckAt: TOMORROW_SIX }, 'no credentials file: the login is expired');
    assert.deepEqual(await logLines(kit), []);
    assert.equal(await probeOf(kit), undefined);
    await kit.files.write(CREDENTIALS, '{}');
    const claimAt = kit.clock.now();
    assert.match((await checkTab(kit, ALPHA_TAB)).stdout[0] ?? '', DAY_START_TOAST);
    assert.deepEqual(await probeOf(kit), { moment: SIX, tab: ALPHA_TAB, at: claimAt, releasedAt: undefined });
    assert.deepEqual(await probeLines(kit), [`day-probe: claimed by app/alpha (${ALPHA_TAB}) for the moment at 2030-01-08T06:00:00.000Z, the first tab due`]);
    kit.clock.advance(10 * SECOND);
    assert.deepEqual(answerOf(await checkTab(kit, OTHER_TAB)), { kind: 'wait', watch: probeWatchOf('bravo'), recheckAt: kit.clock.now() + DAY_PROBE_RECHECK_MS });
    assert.deepEqual(answerOf(await checkTab(kit, OTHER_TAB)), { kind: 'wait', watch: probeWatchOf('bravo'), recheckAt: kit.clock.now() + DAY_PROBE_RECHECK_MS }, 'the moment stays due');
    await kit.files.write(PROBE_FILE, formatDayProbe({ moment: SIX, tab: ALPHA_TAB, at: claimAt, releasedAt: kit.clock.now() }));
    assert.match((await checkTab(kit, OTHER_TAB)).stdout[0] ?? '', DAY_START_TOAST, 'a reply released the probe');
    assert.deepEqual((await logLines(kit)).map((line) => (isRecord(line) ? line['session'] : undefined)), ['alpha', 'bravo']);
  });

  it('hands a probe with no reply in time to the next due tab', async () => {
    const kit = await expiredTeam();
    await kit.files.write(CREDENTIALS, '{}');
    const claimAt = kit.clock.now();
    assert.match((await checkTab(kit, ALPHA_TAB)).stdout[0] ?? '', DAY_START_TOAST);
    kit.clock.advance(LOGIN_PROBE_STALE_MS - MINUTE / 2);
    assert.deepEqual(answerOf(await checkTab(kit, OTHER_TAB)), { kind: 'wait', watch: probeWatchOf('bravo'), recheckAt: claimAt + LOGIN_PROBE_STALE_MS }, 'the recheck comes no later than the stale line');
    kit.clock.advance(MINUTE / 2);
    assert.match((await checkTab(kit, OTHER_TAB)).stdout[0] ?? '', DAY_START_TOAST);
    assert.deepEqual(await probeOf(kit), { moment: SIX, tab: OTHER_TAB, at: kit.clock.now(), releasedAt: undefined });
    assert.equal((await probeLines(kit))[1], `day-probe: claimed by app/bravo (${OTHER_TAB}) for the moment at 2030-01-08T06:00:00.000Z, the probe out had no reply in 5 min`);
  });
});

describe('hook wake-check, the daily usage rollup', () => {
  const DAY_START = { ...TEAM, wake: { dayStartUtc: '06:00' } };
  const RUN_LOG = join(TEAM_HOME, 'state', 'usage', 'rollup', 'runs.log');
  /** `self` in src/testing/quiet-world.ts. */
  const NODE = '/usr/bin/node';
  const SCRIPT = '/opt/teamrig/dist/cli/main.js';
  const rollupsOf = (processes: FakeProcesses): readonly RunRequest[] => processes.hidden.filter(({ args }) => args.includes('rollup'));

  it('starts one hidden run through the queue for the team, on a day with no work to wake for', async () => {
    const kit = await teamWithAlphaTab(DAY_START);
    const processes = new FakeProcesses();
    await checkUnder(kit, processes);
    const [run, ...others] = rollupsOf(processes);
    assert.deepEqual(others, []);
    assert.equal(run?.command, NODE);
    assert.deepEqual(run?.args, [SCRIPT, 'queue', '--what', 'usage rollup', '--small', '--session', 'alpha', '--', NODE, SCRIPT, 'budget', 'rollup', '--apply']);
    assert.equal(run?.env[ENV.team], 'app');
  });

  it('starts no second run that day, and one again the next day', async () => {
    const kit = await teamWithAlphaTab(DAY_START);
    const processes = new FakeProcesses();
    await checkUnder(kit, processes);
    await checkUnder(kit, processes);
    assert.equal(rollupsOf(processes).length, 1);
    kit.clock.advance(24 * 60 * MINUTE);
    await checkUnder(kit, processes);
    assert.equal(rollupsOf(processes).length, 2);
  });

  it('starts none for a team with no day start', async () => {
    const kit = await teamWithAlphaTab(TEAM);
    const processes = new FakeProcesses();
    await checkUnder(kit, processes);
    assert.deepEqual(rollupsOf(processes), []);
  });

  it('logs a start that failed and leaves the day to the next run', async () => {
    const kit = await teamWithAlphaTab(DAY_START);
    const processes = new FakeProcesses().onStart(NODE, { kind: 'missing' });
    await checkUnder(kit, processes);
    await checkUnder(kit, processes);
    assert.equal(rollupsOf(processes).length, 1);
    assert.equal(kit.files.get(RUN_LOG), '2030-01-08T10:00:00.000Z FAILED to start: node was not found\n');
  });
});
