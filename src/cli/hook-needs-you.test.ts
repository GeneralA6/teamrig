import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { JsonRecord } from '../core/guards.ts';
import { FOCUS_TITLE_VAR } from '../open/focus.ts';
import { TabNeedStore, type TabNeed } from '../tabs/need.ts';
import { APP, CliHarness, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { holdFileLock } from '../testing/held-file-lock.ts';
import { EXIT } from './runtime.ts';

const ALPHA_TAB = '0123abcd-0000-4000-8000-0000000000a1';
const TABS = join(TEAM_HOME, 'state', 'tabs');
const LOCK = join(TEAM_HOME, 'state', 'needs-you.lock');
const BRAVO_PID = 7100;
const LEAD_PID = 7200;
const ASKING: TabNeed = { session: 'bravo', state: 'waiting', kind: 'permission', text: 'Bash: teamrig merge T1', task: 'T1', pid: BRAVO_PID, since: '2030-01-08T09:58:00.000Z' };

/** A team whose alpha read its inbox from ALPHA_TAB, so that tab is alpha's, with bravo's and lead's Claude Code running. */
async function team(needsYou: JsonRecord = {}): Promise<CliHarness> {
  const kit = new CliHarness({ ...TEAM, needsYou });
  await kit.run(['inbox', 'read', '--session', 'alpha'], { env: { CLAUDE_CODE_SESSION_ID: ALPHA_TAB } });
  for (const pid of [BRAVO_PID, LEAD_PID]) {
    kit.sessionProcesses.add({ pid, parentPid: 1, name: 'claude.exe', commandLine: 'claude' });
  }
  return kit;
}

async function tabs(kit: CliHarness, ...needs: readonly TabNeed[]): Promise<void> {
  const store = new TabNeedStore(kit.files, { tabs: TABS });
  for (const need of needs) {
    await store.record(need);
  }
}

function look(kit: CliHarness, processes = new FakeProcesses()): Promise<CliResult> {
  return kit.run(['hook', 'needs-you'], { stdin: JSON.stringify({ session_id: ALPHA_TAB, cwd: APP }), processes, platform: 'win32' });
}

function focus(kit: CliHarness, session: string, processes: FakeProcesses): Promise<CliResult> {
  return kit.run(['hook', 'needs-you-focus'], { stdin: JSON.stringify({ session_id: ALPHA_TAB, cwd: APP, session }), processes, platform: 'win32' });
}

function answerOf(result: CliResult): unknown {
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  assert.equal(result.stdout.length, 1);
  return JSON.parse(result.stdout[0] ?? '');
}

function shown(need: TabNeed, focusOffered = true): JsonRecord {
  return { session: need.session, tab: `[app] ${need.session}`, kind: need.kind, text: need.text, task: need.task, since: need.since, focus: focusOffered };
}

describe('runCli: hook needs-you', () => {
  it("answers the other tabs' asks newest first, leaving out its own tab, kinds the config leaves out and ended tabs", async () => {
    const kit = await team();
    const question: TabNeed = { ...ASKING, session: 'lead', kind: 'question', text: 'Friday or Monday?', task: null, pid: LEAD_PID, since: '2030-01-08T09:59:00.000Z' };
    const own: TabNeed = { ...ASKING, session: 'alpha', pid: null };
    await tabs(kit, ASKING, question, own);
    assert.deepEqual(answerOf(await look(kit)), { kind: 'asks', asks: [shown(question), shown(ASKING)] });
    await tabs(kit, { ...question, kind: 'error', text: 'an API error' }, { ...ASKING, pid: 7999 });
    assert.deepEqual(answerOf(await look(kit)), { kind: 'asks', asks: [] }, 'an error is no default kind, and pid 7999 runs no Claude Code');
    await tabs(kit, { ...ASKING, state: 'working', kind: null, text: null, task: null });
    assert.deepEqual(answerOf(await look(kit)), { kind: 'asks', asks: [] });
  });

  it('is off with needsYou.enabled false, and for a tab that is no team session', async () => {
    const off = await team({ enabled: false });
    await tabs(off, ASKING);
    assert.deepEqual(answerOf(await look(off)), { kind: 'off', why: 'needsYou.enabled is false' });
    const stranger = new CliHarness(TEAM);
    assert.deepEqual(answerOf(await look(stranger)), { kind: 'off', why: 'this tab is not a team session' });
  });

  it("offers Focus during the owner's open meeting only for a p0 task's ask, and refuses the focus of any other", async () => {
    const kit = await team();
    const added = await kit.run(['add', '--title', 'Ship it', '--description', 'what and why', '--priority', 'p0', '--owner', 'bravo', '--session', 'lead']);
    assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
    const urgent: TabNeed = { ...ASKING, session: 'lead', pid: LEAD_PID, task: 'T1', since: '2030-01-08T09:59:00.000Z' };
    const plain: TabNeed = { ...ASKING, task: null };
    await tabs(kit, urgent, plain);
    assert.equal((await kit.run(['meeting', 'start', '--session', 'lead'])).code, EXIT.ok);
    assert.deepEqual(answerOf(await look(kit)), { kind: 'asks', asks: [shown(urgent), shown(plain, false)] });
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await focus(kit, 'bravo', processes)), { kind: 'refused', why: "the owner's meeting is open and bravo's ask is no p0 task's" });
    assert.deepEqual(processes.ran, []);
    assert.deepEqual(answerOf(await focus(kit, 'lead', processes)), { kind: 'focused', text: 'focused [app] lead' });
  });

  it('sends one OS notification per ask across the team with osToast on, and none while another tab holds the lock', async () => {
    const kit = await team({ osToast: true });
    await tabs(kit, ASKING);
    const processes = new FakeProcesses();
    await look(kit, processes);
    await look(kit, processes);
    assert.equal(processes.hidden.length, 1);
    assert.equal(processes.hidden[0]?.env['TEAMRIG_NOTICE_TITLE'], '[app] bravo needs you');
    assert.equal(processes.hidden[0]?.env['TEAMRIG_NOTICE_TEXT'], ASKING.text);
    const next: TabNeed = { ...ASKING, text: 'Bash: teamrig merge T2', since: '2030-01-08T10:00:00.000Z' };
    await tabs(kit, next);
    await holdFileLock(kit, LOCK);
    assert.deepEqual(answerOf(await look(kit, processes)), { kind: 'asks', asks: [shown(next)] });
    await kit.files.remove(LOCK);
    assert.equal(processes.hidden.length, 1, 'the lock is busy: the next look sends it');
    await look(kit, processes);
    assert.equal(processes.hidden.length, 2);
  });
});

describe('runCli: hook needs-you-focus', () => {
  it('brings the asking tab to the front by its title, and refuses a tab that asks nothing or no session named', async () => {
    const kit = await team();
    await tabs(kit, ASKING);
    const processes = new FakeProcesses();
    assert.deepEqual(answerOf(await focus(kit, 'bravo', processes)), { kind: 'focused', text: 'focused [app] bravo' });
    assert.equal(processes.ran[0]?.env[FOCUS_TITLE_VAR], '[app] bravo');
    assert.deepEqual(answerOf(await focus(kit, 'lead', processes)), { kind: 'refused', why: 'lead asks nothing now' });
    const unnamed = await kit.run(['hook', 'needs-you-focus'], { stdin: JSON.stringify({ session_id: ALPHA_TAB, cwd: APP }), processes });
    assert.deepEqual(answerOf(unnamed), { kind: 'refused', why: 'stdin names no session' });
  });
});
