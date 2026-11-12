import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { EffortLevel } from '../config/types.ts';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { decodePrompt, refreshPrompt } from '../open/prompt.ts';
import type { ProcessInfo } from '../open/session-processes.ts';
import { askFileOf } from '../mod/clear-hand.ts';
import { ClearAsks, clearAskDir } from '../refresh/clear-asks.ts';
import { RefreshStore } from '../refresh/store.ts';
import { APP, AUTO_RESTART_TEAM, CLAUDE_SESSION, CliHarness, KIT, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { EXIT } from './runtime.ts';

const AT = '2030-01-08T09:59:59.000Z';
const TRANSCRIPT = join('/', 'u', '.claude', 'projects', 'app', 'session.jsonl');
const INBOX = join(TEAM_HOME, 'state', 'inbox', 'alpha.md');
const RESTART_LOG = join(TEAM_HOME, 'state', 'refresh', 'restarts.jsonl');
const CLAUDE: ProcessInfo = { pid: 4100, parentPid: 4000, name: 'claude.exe', commandLine: 'claude' };
const SHELL: ProcessInfo = { pid: 4000, parentPid: 1, name: 'powershell.exe', commandLine: 'powershell -NoExit -Command claude --resume x' };
const RESTART_ALPHA = ['restart', 'alpha', '--team', 'app', '--at', AT, '--project', APP];

/** A team whose session alpha wrote its handover and asked for its restart, with its Claude Code running. */
async function armed(supervised: boolean, config: JsonRecord = AUTO_RESTART_TEAM, effort: EffortLevel | null = null, session = 'alpha'): Promise<{ kit: CliHarness; store: RefreshStore; processes: FakeSessionProcesses }> {
  const kit = new CliHarness(config);
  // A finished turn: the restart waits while one still runs.
  await kit.files.write(TRANSCRIPT, '{"type":"user"}\n{"type":"system","subtype":"turn_duration"}\n');
  const store = new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
  await store.setState(session, { phase: 'ready', task: 'T3', at: AT, tokens: null, noticed: true, transcript: null, claudePid: null });
  await store.setRestart(session, { phase: 'pending', at: AT, pid: CLAUDE.pid, claudeSession: CLAUDE_SESSION, transcript: TRANSCRIPT, cwd: APP, supervised, effort });
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

  it("leaves the session to its tab when the tab's mod claims the ask, writing no inbox line", async () => {
    const { kit, store, processes } = await armed(true);
    const asks = new ClearAsks(kit.files, clearAskDir(KIT));
    let posted: unknown;
    const sleep = async (ms: number): Promise<void> => {
      await kit.clock.sleep(ms);
      const text = kit.files.get(askFileOf(clearAskDir(KIT), CLAUDE_SESSION) ?? '');
      posted = text === undefined ? posted : JSON.parse(text);
      if ((await asks.ask(CLAUDE_SESSION)) !== undefined && (await asks.claim(CLAUDE_SESSION))) {
        await store.clearRestart('alpha');
      }
    };
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes, platform: 'win32', sleep });
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['CLEARED app-alpha: its tab ran /clear'], stderr: [] });
    assert.deepEqual(isRecord(posted) ? posted['hold'] : undefined, { countdownMs: 20_000, afterActivityMs: 1_800_000 }, "the team's default hold, for the tab's mod");
    assert.equal(isRecord(posted) ? posted['askEveryMs'] : undefined, 15_000, "the team's default quiet delay, for the tab's band");
    assert.deepEqual(processes.ends, []);
    assert.equal(await store.restart('alpha'), undefined);
    assert.equal(kit.files.get(INBOX), undefined);
  });

  it("ends a session that runs at another effort level than its config's, when the tab's mod claims the end ask (T2444)", async () => {
    const { kit, store, processes } = await armed(true, { ...AUTO_RESTART_TEAM, launch: { alpha: { effort: 'medium' } } }, 'xhigh');
    const asks = new ClearAsks(kit.files, clearAskDir(KIT));
    const modes: string[] = [];
    const sleep = async (ms: number): Promise<void> => {
      await kit.clock.sleep(ms);
      const ask = await asks.ask(CLAUDE_SESSION);
      if (ask !== undefined && modes.length === 0) {
        modes.push(ask.mode);
        assert.equal(await asks.claimEnd(CLAUDE_SESSION), true);
      }
    };
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes, platform: 'win32', sleep });
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['RESTARTED app-alpha in the same tab'], stderr: [] });
    assert.deepEqual(modes, ['end'], "the config's level, read by the command, differs from the running one");
    assert.deepEqual(processes.ends, [{ pid: CLAUDE.pid, how: 'ask' }]);
    assert.equal((await store.restart('alpha'))?.phase, 'ending', 'launch starts it again');
  });

  it('opens a new tab that launches the session, then closes the old tab', async () => {
    const { kit, store, processes } = await armed(false);
    const tabs = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes, processes: tabs, platform: 'win32' });
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['RESTARTED app-alpha in a new tab'], stderr: [] });
    const [tab] = tabs.started;
    assert.ok(tab);
    assert.deepEqual(tab.args.slice(0, 7), ['-w', '0', 'new-tab', '--title', '[app] alpha', '-d', APP]);
    assert.ok(tab.args.includes('launch'));
    const encoded = tab.args[tab.args.indexOf('--encoded-prompt') + 1] ?? '';
    assert.equal(decodePrompt(encoded), refreshPrompt('app', 'alpha', store.handoverPath('alpha')), 'the new session starts at its handover');
    assert.deepEqual(processes.ends, [{ pid: SHELL.pid, how: 'ask' }]);
    assert.equal(await store.restart('alpha'), undefined);
  });

  it("opens the new tab in the team's own Windows Terminal window when open.teamWindow is on (T1427)", async () => {
    const { kit, processes } = await armed(false, { ...AUTO_RESTART_TEAM, open: { teamWindow: true } });
    const tabs = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes, processes: tabs, platform: 'win32' });
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['RESTARTED app-alpha in a new tab'], stderr: [] });
    assert.deepEqual(tabs.started[0]?.args.slice(0, 3), ['-w', 'teamrig-app', 'new-tab']);
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
    const { kit, processes } = await armed(true, { ...TEAM, refresh: { autoRestart: true, endCommand: ['node', 'end.cjs'] } });
    processes.onFeed('node', { kind: 'failed', error: 'exit code 1' });
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes, platform: 'win32' });
    assert.equal(result.code, EXIT.ok);
    assert.match(kit.files.get(INBOX) ?? '', /teamrig: you were restarted, but refresh\.endCommand failed \(exit code 1\)/);
  });

  it("restarts the lead by default and cancels a member's restart, the default automatic restart being on for the lead only", async () => {
    const lead = await armed(true, TEAM, null, 'lead');
    const restarted = await lead.kit.run(['restart', 'lead', '--team', 'app', '--at', AT, '--project', APP], { sessionProcesses: lead.processes, platform: 'win32' });
    assert.deepEqual(restarted.stdout, ['RESTARTED app-lead in the same tab']);
    const member = await armed(true, TEAM);
    const cancelled = await member.kit.run(RESTART_ALPHA, { sessionProcesses: member.processes });
    assert.match(cancelled.stdout[0] ?? '', /^CANCELLED the restart of app-alpha: the automatic restart is off/);
  });

  it('cancels, clearing the request, when the automatic restart is off', async () => {
    const { kit, store, processes } = await armed(true, TEAM);
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes });
    assert.deepEqual(result.stdout, ['CANCELLED the restart of app-alpha: the automatic restart is off (refresh.autoRestart in the team config)']);
    assert.deepEqual(processes.ends, []);
    assert.equal(await store.restart('alpha'), undefined);
  });

  const outcomes: readonly { readonly name: string; readonly supervised: boolean; readonly config: JsonRecord; readonly kind: string; readonly why: RegExp | undefined }[] = [
    { name: 'a restart', supervised: true, config: AUTO_RESTART_TEAM, kind: 'restarted', why: undefined },
    { name: 'a restart that did not happen', supervised: false, config: AUTO_RESTART_TEAM, kind: 'failed', why: /^no new tab opened/ },
    { name: 'a restart while the automatic restart is off', supervised: true, config: TEAM, kind: 'cancelled', why: /^the automatic restart is off/ },
  ];
  for (const outcome of outcomes) {
    it(`logs ${outcome.name} to the restart log`, async () => {
      const { kit, processes } = await armed(outcome.supervised, outcome.config);
      await kit.run(RESTART_ALPHA, { sessionProcesses: processes, processes: new FakeProcesses(), platform: 'win32' });
      const lines = (kit.files.get(RESTART_LOG) ?? '').split('\n').filter((line) => line !== '');
      assert.equal(lines.length, 1);
      const entry: unknown = JSON.parse(lines[0] ?? '');
      assert.ok(isRecord(entry));
      assert.equal(stringField(entry, 'session'), 'alpha');
      assert.equal(stringField(entry, 'at'), AT);
      assert.ok(Date.parse(stringField(entry, 'endedAt') ?? '') >= Date.parse(AT));
      const result = recordField(entry, 'result');
      assert.ok(result !== undefined);
      assert.equal(stringField(result, 'kind'), outcome.kind);
      if (outcome.why !== undefined) {
        assert.match(stringField(result, 'why') ?? '', outcome.why);
      }
    });
  }

  it('still restarts when the restart log cannot be written, and says so', async () => {
    const { kit, processes } = await armed(true);
    const files = new FaultyFiles(kit.files).fail('append', RESTART_LOG, systemError('EACCES', 'EACCES: permission denied'));
    const result = await kit.run(RESTART_ALPHA, { sessionProcesses: processes, platform: 'win32', files });
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['RESTARTED app-alpha in the same tab'], stderr: ['WARN the restart log was not written: EACCES: permission denied'] });
    assert.deepEqual(processes.ends, [{ pid: CLAUDE.pid, how: 'ask' }]);
  });

  it('refuses a time that is not one', async () => {
    const { kit } = await armed(true);
    const result = await kit.run(['restart', 'alpha', '--team', 'app', '--at', 'soon', '--project', APP]);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr.join('\n'), /--at "soon" is not a time/);
  });
});
