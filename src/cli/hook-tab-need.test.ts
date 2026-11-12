import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { TabNeedStore, type TabNeed } from '../tabs/need.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { EXIT } from './runtime.ts';

const TABS = join(TEAM_HOME, 'state', 'tabs');
const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);
const ALPHA = { TEAMRIG_SESSION: 'alpha' };
const SINCE = '2030-01-08T10:00:00.000Z';
const CLAUDE_PID = 7000;

function payload(event: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: event, session_id: CLAUDE_SESSION, cwd: APP, transcript_path: TRANSCRIPT, ...fields });
}

function tabOf(kit: CliHarness): Promise<TabNeed | undefined> {
  return new TabNeedStore(kit.files, { tabs: TABS }).read('alpha');
}

const WORKING: TabNeed = { session: 'alpha', state: 'working', kind: null, text: null, task: null, pid: CLAUDE_PID, since: SINCE };

describe('hooks: the tab file', () => {
  it('records a permission prompt with tab status off, then clears it at the tool end, and the session end removes it', async () => {
    const kit = new CliHarness(TEAM);
    const asked = payload('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'teamrig merge T12' } });
    assert.equal((await kit.run(['hook', 'tab-status'], { stdin: asked, env: ALPHA })).code, EXIT.ok);
    assert.deepEqual(await tabOf(kit), { ...WORKING, state: 'waiting', kind: 'permission', text: 'Bash: teamrig merge T12', task: 'T12' });
    kit.clock.advance(60_000);
    await kit.run(['hook', 'tool-end'], { stdin: payload('PostToolUse', { tool_name: 'Bash' }), env: ALPHA });
    assert.deepEqual(await tabOf(kit), { ...WORKING, since: '2030-01-08T10:01:00.000Z' });
    await kit.run(['hook', 'tab-status'], { stdin: payload('SessionEnd'), env: ALPHA });
    assert.equal(await tabOf(kit), undefined);
    assert.deepEqual(kit.files.paths().filter((path) => path.includes('tabs')), []);
  });

  it('records a question and a decision at the turn end, and a plain end as ready', async () => {
    const kit = new CliHarness(TEAM);
    const question = payload('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Friday or Monday?' }] } });
    await kit.run(['hook', 'tab-status'], { stdin: question, env: ALPHA });
    assert.deepEqual(await tabOf(kit), { ...WORKING, state: 'waiting', kind: 'question', text: 'Friday or Monday?' });
    const decision = payload('Stop', { stop_hook_active: false, last_assistant_message: 'T4 is ready.\n\nDecision needed: ship it?' });
    await kit.run(['hook', 'stop'], { stdin: decision, env: ALPHA });
    assert.deepEqual(await tabOf(kit), { ...WORKING, state: 'decision', kind: 'decision', text: 'Decision needed: ship it?', task: 'T4' });
    await kit.run(['hook', 'stop'], { stdin: payload('Stop', { stop_hook_active: false, last_assistant_message: 'Shipped.' }), env: ALPHA });
    assert.deepEqual(await tabOf(kit), { ...WORKING, state: 'ready' });
  });

  it('keeps the file for an event that changes nothing, and writes none for a tab that is no session or on an error', async () => {
    const kit = new CliHarness(TEAM);
    await kit.run(['hook', 'tab-status'], { stdin: payload('UserPromptSubmit', { prompt: 'go' }), env: ALPHA });
    await kit.run(['hook', 'tab-status'], { stdin: payload('PreToolUse', { tool_name: 'Bash' }), env: ALPHA });
    assert.deepEqual(await tabOf(kit), WORKING);
    const stranger = new CliHarness(TEAM);
    await stranger.run(['hook', 'tab-status'], { stdin: payload('PermissionRequest', { tool_name: 'Bash' }) });
    assert.deepEqual(stranger.files.paths().filter((path) => path.includes('tabs')), []);
    const broken = new CliHarness(TEAM);
    const faulty = new FaultyFiles(broken.files).fail('write', join(TABS, 'alpha.json'), systemError('EACCES'));
    const result = await broken.run(['hook', 'tab-status'], { stdin: payload('PermissionRequest', { tool_name: 'Bash' }), env: ALPHA, files: faulty });
    assert.deepEqual([result.code, result.stdout], [EXIT.ok, []]);
  });

  it('lets the tool end and the turn end answer as ever when the tab file cannot be written', async () => {
    const kit = new CliHarness(TEAM);
    const faulty = new FaultyFiles(kit.files).fail('write', join(TABS, 'alpha.json'), systemError('EACCES'));
    const toolEnd = await kit.run(['hook', 'tool-end'], { stdin: payload('PostToolUse', { tool_name: 'Bash' }), env: ALPHA, files: faulty });
    assert.deepEqual([toolEnd.code, toolEnd.stderr], [EXIT.ok, []]);
    const stop = await kit.run(['hook', 'stop'], { stdin: payload('Stop', { stop_hook_active: false, last_assistant_message: 'Shipped.' }), env: ALPHA, files: faulty });
    assert.deepEqual([stop.code, stop.stderr], [EXIT.ok, []]);
    assert.equal(await tabOf(kit), undefined);
  });
});
