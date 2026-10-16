import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { decodePrompt, refreshPrompt } from '../open/prompt.ts';
import type { ProcessInfo } from '../open/session-processes.ts';
import { RefreshStore } from '../refresh/store.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { EXIT } from './runtime.ts';

const AT = '2030-01-08T09:59:59.000Z';
const TRANSCRIPT = join('/', 'u', '.claude', 'projects', 'app', 'session.jsonl');
const INBOX = join(TEAM_HOME, 'state', 'inbox', 'alpha.md');
const CLAUDE: ProcessInfo = { pid: 4100, parentPid: 4000, name: 'claude.exe', commandLine: 'claude' };
const SHELL: ProcessInfo = { pid: 4000, parentPid: 1, name: 'powershell.exe', commandLine: 'powershell -NoExit -Command claude --resume x' };
const RESTART_ALPHA = ['restart', 'alpha', '--team', 'app', '--at', AT, '--project', APP];

/** A team whose session alpha wrote its handover and asked for its restart, with its Claude Code running. */
async function armed(supervised: boolean, config: JsonRecord = TEAM): Promise<{ kit: CliHarness; store: RefreshStore; processes: FakeSessionProcesses }> {
  const kit = new CliHarness(config);
  // A finished turn: the restart waits while one still runs.
  await kit.files.write(TRANSCRIPT, '{"type":"user"}\n{"type":"system","subtype":"turn_duration"}\n');
  const store = new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
  await store.setState('alpha', { phase: 'ready', task: 'T3', at: AT, noticed: true, transcript: null, claudePid: null });
  await store.setRestart('alpha', { phase: 'pending', at: AT, pid: CLAUDE.pid, claudeSession: CLAUDE_SESSION, transcript: TRANSCRIPT, cwd: APP, supervised });
  return { kit, store, processes: new FakeSessionProcesses().add(SHELL).add(CLAUDE) };
}

describe('teamrig restart', () => {
  it('ends a session under launch after the delay, leaving launch to start it again', async () => {
    const { kit, store, processes } = await armed(true);
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes, platform: 'win32' });
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['RESTARTED app-alpha in the same tab'], stderr: [] });
    assert.deepEqual(processes.ends, [{ pid: CLAUDE.pid, how: 'ask' }]);
    assert.equal((await store.restart('alpha'))?.phase, 'ending');
    assert.equal(kit.files.get(INBOX), undefined);
  });

  it('opens a new tab that launches the session, then closes the old tab', async () => {
    const { kit, store, processes } = await armed(false);
    const tabs = new FakeProcesses().onStart('wt.exe', { kind: 'started' });
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes, processes: tabs, platform: 'win32' });
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['RESTARTED app-alpha in a new tab'], stderr: [] });
    const [tab] = tabs.started;
    assert.ok(tab);
    assert.deepEqual(tab.args.slice(0, 7), ['-w', '0', 'new-tab', '--title', 'app-alpha', '-d', APP]);
    assert.ok(tab.args.includes('launch'));
    const encoded = tab.args[tab.args.indexOf('--encoded-prompt') + 1] ?? '';
    assert.equal(decodePrompt(encoded), refreshPrompt('app', 'alpha', store.handoverPath('alpha')), 'the new session starts at its handover');
    assert.deepEqual(processes.ends, [{ pid: SHELL.pid, how: 'ask' }]);
    assert.equal(await store.restart('alpha'), undefined);
  });

  it('tells the session in its inbox when no restart happened, and exits 1', async () => {
    const { kit, processes } = await armed(false);
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes, processes: new FakeProcesses(), platform: 'win32' });
    assert.equal(result.code, EXIT.failed);
    assert.match(result.stdout[0] ?? '', /^FAILED the restart of app-alpha: no new tab opened/);
    assert.deepEqual(processes.ends, []);
    assert.match(kit.files.get(INBOX) ?? '', /^- 2030-01-08 10:00Z? teamrig: the automatic restart did not happen: no new tab opened .*; type \/clear for a fresh start\n$/);
  });

  it('tells the restarted session when refresh.endCommand failed', async () => {
    const { kit, processes } = await armed(true, { ...TEAM, refresh: { endCommand: ['node', 'end.cjs'] } });
    processes.onFeed('node', { kind: 'failed', error: 'exit code 1' });
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes, platform: 'win32' });
    assert.equal(result.code, EXIT.ok);
    assert.match(kit.files.get(INBOX) ?? '', /teamrig: you were restarted, but refresh\.endCommand failed \(exit code 1\)/);
  });

  it('cancels, clearing the request, when the automatic restart is off', async () => {
    const { kit, store, processes } = await armed(true, { ...TEAM, refresh: { autoRestart: false } });
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes });
    assert.deepEqual(result.stdout, ['CANCELLED the restart of app-alpha: the automatic restart is off (refresh.autoRestart in the team config)']);
    assert.deepEqual(processes.ends, []);
    assert.equal(await store.restart('alpha'), undefined);
  });

  it('refuses a time that is not one', async () => {
    const { kit } = await armed(true);
    const result = await kit.run(['restart', 'alpha', '--team', 'app', '--at', 'soon', '--project', APP]);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr.join('\n'), /--at "soon" is not a time/);
  });
});
