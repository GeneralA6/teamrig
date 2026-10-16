import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { JsonRecord } from '../core/guards.ts';
import { EXIT } from './runtime.ts';
import { APP, CliHarness, EVENTS_PATH, TEAM, TEAM_HOME, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';

const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
const OTHER_TAB = '0123abcd-0000-4000-8000-0000000000b9';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const WAKE_LOG = join(TEAM_HOME, 'state', 'wakes.jsonl');
const ALPHA_LOCK = join(TEAM_HOME, 'state', 'wake', 'alpha.lock');

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

async function logLines(kit: CliHarness): Promise<unknown[]> {
  const text = (await kit.files.read(WAKE_LOG)) ?? '';
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
