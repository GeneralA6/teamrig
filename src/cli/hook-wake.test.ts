import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Burst } from '../budget/burst.ts';
import { BurstLog } from '../budget/burst-log.ts';
import { MeterLog } from '../budget/calibration.ts';
import type { Files } from '../core/files.ts';
import type { JsonRecord } from '../core/guards.ts';
import { SessionLog } from '../sessions/log.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { EXIT } from './runtime.ts';
import { RESTART_RECHECK_MS } from './commands/hook-wake.ts';
import { GIVE_UP_MS } from '../refresh/restart.ts';
import type { RestartRequest } from '../refresh/state.ts';
import { RefreshStore } from '../refresh/store.ts';
import { APP, CliHarness, EVENTS_PATH, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { WakeAsks } from '../wake/asks.ts';

const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
const OTHER_TAB = '0123abcd-0000-4000-8000-0000000000b9';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const WAKE_LOG = join(TEAM_HOME, 'state', 'wakes.jsonl');
const ALPHA_LOCK = join(TEAM_HOME, 'state', 'wake', 'alpha.lock');
const ASKS = join(TEAM_HOME, 'state', 'wake-asks');

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
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: EVENTS_PATH, recheckAt: null });
    await hand(kit, 'Fix the login', 'p1');
    const start = kit.clock.now();
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: EVENTS_PATH, recheckAt: start + 120 * SECOND });
    kit.clock.advance(120 * SECOND);
    const transcripts = new MemoryTranscripts();
    transcripts.set(join(USER_HOME, '.claude', 'projects', 'work-app', `${ALPHA_TAB}.jsonl`), '{}\n', kit.clock.now() - 5 * MINUTE);
    const woke = answerOf(await check(kit, transcripts));
    assert.deepEqual(woke, {
      kind: 'wake',
      ids: ['T2'],
      text:
        'New work was handed to you while this tab was idle: T2 "Fix the login" (p1). ' +
        'Start a work block (`teamrig start --session alpha`) and work your list in priority order. This wake costs about 27k W, warm cache.',
      toast: 'teamrig woke this tab for T2 (about 27k W, warm cache)',
    });
    assert.deepEqual(await logLines(kit), [
      { v: 1, at: new Date(kit.clock.now()).toISOString(), kind: 'wake', session: 'alpha', tab: ALPHA_TAB, ids: ['T2'], w: 27_000, cold: false },
    ]);
    kit.clock.advance(60 * MINUTE);
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: EVENTS_PATH, recheckAt: null }, 'never twice for one task');
  });

  it('never wakes for less urgent work by default, and wakes for p2 when wake.priority is 2, costed cold with no transcript', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { priority: 2, batchSeconds: 0 }, budget: { weeklyLimitW: 1_000_000_000 } });
    await check(kit);
    await hand(kit, 'Tidy the docs', 'p3');
    await hand(kit, 'Ship the page', 'p2');
    const woke = answerOf(await check(kit));
    assert.ok(typeof woke === 'object' && woke !== null && 'toast' in woke);
    assert.equal(woke.toast, 'teamrig woke this tab for T2 (about 210k W, cold, 0.02% of the week)');
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
    assert.equal(woke.toast, 'teamrig woke this tab for T1 (about 210k W, cold, 0.01% of the week)');
    assert.deepEqual(await logLines(kit), [
      { v: 1, at: new Date(kit.clock.now()).toISOString(), kind: 'wake', session: 'alpha', tab: ALPHA_TAB, ids: ['T1'], w: 210_000, cold: true, weekPct: 0.0105 },
    ]);
  });

  it('wakes for p1 only in quiet hours, whatever wake.priority says', async () => {
    const budget = { enabled: true, overAction: 'ask', quietHours: { startUtc: '09:00', endUtc: '11:00', action: 'ask' } };
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { priority: 2, batchSeconds: 0 }, budget });
    await check(kit);
    await hand(kit, 'Ship the page', 'p2');
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: EVENTS_PATH, recheckAt: null });
    await hand(kit, 'Fix the outage', 'p1');
    assert.equal((await check(kit)).stdout[0]?.includes('"kind":"wake","ids":["T2"]'), true);
  });

  it("ignores the session's own task and work that waits on an unfinished task", async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { batchSeconds: 0 } });
    await check(kit);
    await hand(kit, 'My own idea', 'p1', 'alpha');
    await hand(kit, 'First step', 'p2');
    await kit.run(['add', '--title', 'Second step', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--after', 'T2', '--session', 'lead']);
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: EVENTS_PATH, recheckAt: null });
  });

  it("never wakes the lead while the owner's daily meeting is open, and wakes it for the work handed meanwhile after", async () => {
    const kit = new CliHarness();
    await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
    const leadCheck = () => kit.run(['hook', 'wake-check'], { stdin: payload() });
    await leadCheck();
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    await kit.run(['add', '--title', 'Decide the outage fix', '--description', 'what and why', '--priority', 'p1', '--owner', 'lead', '--session', 'alpha']);
    kit.clock.advance(10 * MINUTE);
    assert.deepEqual(answerOf(await leadCheck()), { kind: 'wait', watch: EVENTS_PATH, recheckAt: null });
    assert.equal((await kit.run(['meeting', 'end', '--session', 'lead'])).code, EXIT.ok);
    const start = kit.clock.now();
    assert.deepEqual(answerOf(await leadCheck()), { kind: 'wait', watch: EVENTS_PATH, recheckAt: start + 120 * SECOND });
    kit.clock.advance(120 * SECOND);
    assert.equal((await leadCheck()).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true);
  });

  it('never wakes a session while its automatic restart may act, whose prompt would cancel it, and wakes it for the work after (T980)', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { batchSeconds: 0 } });
    const store = new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
    const request: RestartRequest = { phase: 'pending', at: new Date(kit.clock.now()).toISOString(), pid: 4100, claudeSession: ALPHA_TAB, transcript: null, cwd: null, supervised: false };
    await check(kit);
    await store.setRestart('alpha', request);
    await hand(kit, 'Fix the login', 'p1');
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: EVENTS_PATH, recheckAt: kit.clock.now() + RESTART_RECHECK_MS });
    await store.setRestart('alpha', { ...request, phase: 'ending' });
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: EVENTS_PATH, recheckAt: kit.clock.now() + RESTART_RECHECK_MS }, 'ending too');
    await store.clearRestart('alpha');
    assert.equal((await check(kit)).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true);
  });

  it('wakes a session whose restart request is older than any restart that could act on it', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { batchSeconds: 0 } });
    const store = new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
    await check(kit);
    const left = new Date(kit.clock.now() - 2 * GIVE_UP_MS).toISOString();
    await store.setRestart('alpha', { phase: 'pending', at: left, pid: 4100, claudeSession: ALPHA_TAB, transcript: null, cwd: null, supervised: false });
    await hand(kit, 'Fix the login', 'p1');
    assert.equal((await check(kit)).stdout[0]?.includes('"kind":"wake","ids":["T1"]'), true);
  });

  it('wakes for an urgent line once it is a batch old, then logs and removes it', async () => {
    const kit = await teamWithAlphaTab();
    const asks = new WakeAsks(kit.files, ASKS);
    await check(kit);
    await asks.post('alpha', { from: 'teamrig', text: 'The idle pass closed bravo.', at: kit.clock.now() });
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: EVENTS_PATH, recheckAt: kit.clock.now() + 120 * SECOND });
    kit.clock.advance(120 * SECOND);
    const woke = answerOf(await check(kit));
    assert.ok(typeof woke === 'object' && woke !== null && 'text' in woke && 'toast' in woke && 'ids' in woke);
    assert.deepEqual(woke.ids, []);
    assert.match(String(woke.text), /^Urgent lines were posted for you while this tab was idle; act on each now:\n- \d\d:\d\d \w+ teamrig: The idle pass closed bravo\.\nThis wake costs about 210k W, cold\.$/);
    assert.equal(woke.toast, 'teamrig woke this tab for an urgent line from teamrig (about 210k W, cold)');
    assert.deepEqual(await logLines(kit), [{ v: 1, at: new Date(kit.clock.now()).toISOString(), kind: 'wake', session: 'alpha', tab: ALPHA_TAB, ids: [], w: 210_000, cold: true, asks: 1 }]);
    assert.deepEqual(await asks.read('alpha'), []);
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: EVENTS_PATH, recheckAt: null }, 'never twice for one line');
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
    assert.equal(woke.toast, 'teamrig woke this tab for T1 and an urgent line from teamrig (about 210k W, cold)');
    await new WakeAsks(kit.files, ASKS).post('alpha', { from: 'bravo', text: 'Bravo has a reply waiting.', at: kit.clock.now() });
    assert.equal((await check(kit)).stdout[0]?.includes('"toast":"teamrig woke this tab for an urgent line from bravo'), true, 'wake.minGapMinutes holds no line');
  });

  it("keeps an urgent line for the lead while the owner's daily meeting is open, and removes a damaged one", async () => {
    const kit = new CliHarness({ ...TEAM, wake: { batchSeconds: 0 } });
    await kit.run(['inbox', 'read', '--session', 'lead'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
    const asks = new WakeAsks(kit.files, ASKS);
    await asks.post('lead', { from: 'teamrig', text: 'The idle pass closed bravo.', at: kit.clock.now() });
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    assert.deepEqual(answerOf(await kit.run(['hook', 'wake-check'], { stdin: payload() })), { kind: 'wait', watch: EVENTS_PATH, recheckAt: null });
    assert.equal((await asks.read('lead')).length, 1);
    await kit.files.write(join(ASKS, 'lead', '1-0.json'), '{"v":1,"from":"teamrig"');
    assert.equal((await kit.run(['meeting', 'end', '--session', 'lead'])).code, EXIT.ok);
    assert.equal((await kit.run(['hook', 'wake-check'], { stdin: payload() })).stdout[0]?.includes('"toast":"teamrig woke this tab for an urgent line from teamrig'), true);
    assert.deepEqual(await asks.read('lead'), [], 'the damaged one goes with the ones the wake took');
  });

  it('answers a recheck now while another tab of the session holds its lock', async () => {
    const kit = await teamWithAlphaTab();
    await kit.files.write(ALPHA_LOCK, JSON.stringify({ pid: 7, at: kit.clock.now() }));
    assert.deepEqual(answerOf(await check(kit)), { kind: 'wait', watch: EVENTS_PATH, recheckAt: kit.clock.now() });
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
  const waitTill = (recheckAt: number | null) => ({ kind: 'wait', watch: EVENTS_PATH, recheckAt });

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
        'Start a work block (`teamrig start --session alpha`) and work your list in priority order. This wake costs about 210k W, cold.',
      toast: 'teamrig woke this tab for the day start: T1 (about 210k W, cold)',
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
    assert.match((await otherCheck()).stdout[0] ?? '', /"toast":"teamrig woke this tab for the day start: T1 \(about 210k W, cold\)"/);
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
    assert.match(woke, /"toast":"teamrig woke this tab for the burst: T1 \(about 210k W, cold\)"/);
    kit.clock.advance(60 * MINUTE);
    assert.deepEqual(answerOf(await check(kit)), waitTill(TOMORROW_SIX), 'once per burst');
  });

  it('lets a wake for handed work go first, then waits out the gap before the day start', async () => {
    const kit = await teamWithAlphaTab({ ...TEAM, wake: { dayStartUtc: '06:00', batchSeconds: 0 } });
    await check(kit);
    await hand(kit, 'Fix the outage', 'p1');
    assert.match((await check(kit)).stdout[0] ?? '', /"text":"New work was handed to you while this tab was idle: T1/);
    assert.deepEqual(answerOf(await check(kit)), waitTill(kit.clock.now() + 15 * MINUTE));
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
  const WAIT = { kind: 'wait', watch: EVENTS_PATH, recheckAt: null };

  /** A dry-run team whose bravo the lead closed at 09:00 UTC; neither lead nor alpha runs. */
  async function idleTeam(config: JsonRecord = DRY_RUN): Promise<CliHarness> {
    const kit = await teamWithAlphaTab(config);
    await new SessionLog(kit.files, SESSION_LOG).append({ kind: 'close', session: 'bravo', by: 'lead', at: '2030-01-08T09:00:00.000Z', claudeSession: 'claude-bravo', idleMinutes: 75, freedMb: 1300 });
    return kit;
  }

  /** Alpha's tab's wake check, over `files`, starting hidden programs through `processes`. */
  function passCheck(kit: CliHarness, { files = kit.files, processes = new FakeProcesses() }: { readonly files?: Files; readonly processes?: FakeProcesses } = {}): Promise<CliResult> {
    return kit.run(['hook', 'wake-check'], { stdin: payload(), files, processes, probe: new FakePathProbe({ folders: [APP] }), memory: new FakeHostMemory().lists([], COMMIT) });
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
    assert.deepEqual(state, { v: 1, at: started, kinds: { lead: 'away', alpha: 'away', bravo: 'reopen' }, pending: { bravo: { act: 'reopen', at: started } } });
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

  it("skips the pass while another tab's check holds its lock, and reads nothing with open.idle.mode off", async () => {
    const kit = await idleTeam();
    await kit.files.write(join(STATE, 'idle-pass.lock'), JSON.stringify({ pid: 7, at: kit.clock.now() }));
    assert.deepEqual(answerOf(await passCheck(kit)), WAIT);
    const off = await idleTeam(TEAM);
    const unreadable = new FaultyFiles(off.files).fail('read', PASS_STATE, systemError('EACCES'));
    assert.deepEqual(answerOf(await passCheck(off, { files: unreadable })), WAIT);
    for (const team of [kit, off]) {
      assert.equal(team.files.get(PASS_LOG), undefined);
      assert.equal(team.files.get(PASS_STATE), undefined);
    }
  });
});

describe('hook wake-dropped', () => {
  it('logs a dropped wake with its reason, and nothing for a tab that is no team session', async () => {
    const kit = await teamWithAlphaTab();
    const dropped = await kit.run(['hook', 'wake-dropped'], { stdin: payload({ reason: 'blocked by a hook' }) });
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
