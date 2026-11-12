import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { projectTranscriptPath } from '../budget/discover.ts';
import type { JsonRecord } from '../core/guards.ts';
import { SessionLog } from '../sessions/log.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe } from '../testing/fake-processes.ts';
import { FakePluginStore } from '../testing/fake-plugin-store.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { WakeAsks } from '../wake/asks.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';

const MB = 2 ** 20;
const MINUTE_MS = 60_000;
/** The harness clock's now. */
const NOW = Date.parse('2030-01-08T10:00:00.000Z');
const SESSIONS = join(TEAM_HOME, 'state', 'sessions');
const LOG = join(TEAM_HOME, 'state', 'session-log.jsonl');
/** Alpha's stored token use, which reading any session's budget loads. */
const ALPHA_USAGE = join(TEAM_HOME, 'state', 'usage', 'alpha.json');
/** A team that meters its budget and wakes for p2 work too. */
const BUDGETED: JsonRecord = { ...TEAM, budget: { enabled: true }, wake: { priority: 2 } };

/** A team whose lead last started in Claude Code 6900 (still running, with a shell) and alpha in 7100 (ended). */
async function recordedTeam(config: JsonRecord = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  const store = new SessionRecordStore(kit.files, { sessions: SESSIONS });
  await store.write('lead', { claudePid: 6900, claudeSession: 'claude-lead', at: '2030-01-08T09:00:00.000Z' });
  await store.write('alpha', { claudePid: 7100, claudeSession: 'claude-alpha', at: '2030-01-08T09:30:00.000Z' });
  return kit;
}

/** As a `ps` list gives them: resident memory only. */
const ROWS = [
  { pid: 6900, parent: 1, bytes: 700 * MB },
  { pid: 6901, parent: 6900, bytes: 150 * MB },
  { pid: 9000, parent: 1, bytes: 4000 * MB },
];

/** As Windows gives them: what each process committed too. */
const COMMITTED_ROWS = [
  { pid: 6900, parent: 1, bytes: 700 * MB, committed: 1600 * MB },
  { pid: 6901, parent: 6900, bytes: 150 * MB, committed: 300 * MB },
  { pid: 9000, parent: 1, bytes: 4000 * MB, committed: 5000 * MB },
];

describe('teamrig sessions', () => {
  it('prints where each session runs and the memory its Claude Code holds and committed, then the host', async () => {
    const kit = await recordedTeam();
    const memory = new FakeHostMemory().lists(COMMITTED_ROWS, { usedMb: 85_300, limitMb: 100_700 });
    memory.free = 21_400;
    const result = await kit.run(['sessions'], { memory });
    assert.equal(result.code, 0, result.stderr.join('\n'));
    assert.deepEqual(result.stdout, [
      'lead app-lead: running in Claude Code 6900, 850 MB, 1900 MB committed',
      'alpha app-alpha: closed: the Claude Code it last started in has ended',
      'bravo app-bravo: no start recorded',
      '1 running hold 850 MB, 1900 MB committed; 1 closed; 1 with no start recorded',
      'host: 21400 MB free; commit 85300 of 100700 MB (85%)',
    ]);
  });

  it('leaves out what is committed where the host does not say', async () => {
    const result = await (await recordedTeam()).run(['sessions'], { memory: new FakeHostMemory().lists(ROWS) });
    assert.deepEqual(result.stdout.slice(0, 1), ['lead app-lead: running in Claude Code 6900, 850 MB']);
    assert.equal(result.stdout[3], '1 running hold 850 MB; 1 closed; 1 with no start recorded');
  });

  it('says so when the host cannot list its processes or give its commit charge', async () => {
    const kit = await recordedTeam();
    const result = await kit.run(['sessions'], { memory: new FakeHostMemory().lists(undefined) });
    assert.deepEqual(result.stdout, [
      "teamrig could not list the host's processes, so it cannot tell which sessions run.",
      'host: 8000 MB free; commit charge unknown on this system',
    ]);
  });

  it('refuses an argument, and --project without --pass', async () => {
    const result = await (await recordedTeam()).run(['sessions', 'alpha']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr.join('\n'), /unexpected "alpha"/);
    const project = await (await recordedTeam()).run(['sessions', '--project', APP]);
    assert.notEqual(project.code, 0);
    assert.match(project.stderr.join('\n'), /--project goes with --pass/);
  });
});

const ALPHA_TAB = { pid: 8000, parentPid: 7900, name: 'powershell.exe', commandLine: `powershell -NoExit -Command claude --resume ${CLAUDE_SESSION}` };
const ALPHA_CLAUDE = { pid: 8100, parentPid: ALPHA_TAB.pid, name: 'claude.exe', commandLine: `claude --resume ${CLAUDE_SESSION}` };
/** Alpha's last reply, 40k tokens of context: small enough to resume. */
const REPLY = `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: 39_998, output_tokens: 50 } } })}\n`;

/**
 * A pass over a team whose lead runs in Claude Code 6900 and alpha in 8100, quiet 75 min, its transcript in the project
 * folder `project`; bravo never started.
 */
async function runningTeam(config: JsonRecord = TEAM, project = APP): Promise<{ readonly kit: CliHarness; readonly processes: FakeSessionProcesses; readonly options: RunOptions }> {
  const kit = await recordedTeam(config);
  const transcript = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), project, CLAUDE_SESSION);
  await new SessionRecordStore(kit.files, { sessions: SESSIONS }).write('alpha', { claudePid: ALPHA_CLAUDE.pid, claudeSession: CLAUDE_SESSION, at: '2030-01-08T08:00:00.000Z' });
  await kit.files.write(transcript, REPLY);
  const processes = new FakeSessionProcesses().add(ALPHA_TAB).add(ALPHA_CLAUDE);
  const rows = [
    { pid: 6900, parent: 1, bytes: 700 * MB, committed: 1600 * MB },
    { pid: ALPHA_CLAUDE.pid, parent: ALPHA_TAB.pid, bytes: 1100 * MB, committed: 1500 * MB },
    { pid: 8101, parent: ALPHA_CLAUDE.pid, bytes: 200 * MB, committed: 300 * MB },
  ];
  const options: RunOptions = {
    platform: 'win32',
    probe: new FakePathProbe({ folders: [APP, project] }),
    memory: new FakeHostMemory().lists(rows),
    sessionProcesses: processes,
    transcripts: new MemoryTranscripts({ [transcript]: REPLY }, NOW - 75 * MINUTE_MS),
  };
  return { kit, processes, options };
}

/** A team none of whose sessions runs, alpha and bravo closed by the lead at 09:00 UTC. */
async function closedTeam(config: JsonRecord = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  const log = new SessionLog(kit.files, LOG);
  for (const session of ['alpha', 'bravo']) {
    await log.append({ kind: 'close', session, by: 'lead', at: '2030-01-08T09:00:00.000Z', claudeSession: `claude-${session}`, idleMinutes: 75, freedMb: 1300 });
  }
  return kit;
}

async function hand(kit: CliHarness, owner: string, priority: string): Promise<void> {
  const added = await kit.run(['add', '--title', `Ship ${owner}'s part`, '--description', 'what and why', '--priority', priority, '--owner', owner, '--session', 'lead']);
  assert.equal(added.code, 0, added.stderr.join('\n'));
}

function assertOk(result: CliResult): void {
  assert.equal(result.code, 0, [...result.stdout, ...result.stderr].join('\n'));
}

describe('teamrig sessions --pass', () => {
  it('closes an idle session, keeps the lead and leaves one teamrig did not close, changing nothing', async () => {
    const team = await runningTeam();
    const result = await team.kit.run(['sessions', '--pass'], team.options);
    assertOk(result);
    assert.deepEqual(result.stdout, [
      'KEEP app-lead (session lead) holds the lead role: teamrig never closes it',
      'CLOSE app-alpha (session alpha): quiet 75 min, its Claude Code holds 1300 MB, 1800 MB committed',
      'AWAY app-bravo (session bravo): not running, and teamrig did not close it',
      'PASS 3 session(s): 1 to close, 0 to reopen, 0 to reopen later, 1 kept open, 0 closed, 1 away; nothing changed',
    ]);
    assert.deepEqual(team.processes.ends, [], 'the pass ends nothing');
    assert.equal(team.kit.files.get(LOG), undefined, 'and logs nothing');
  });

  it("reads a running session's transcript in its own launch.<id>.project folder", async () => {
    const own = resolve('/', 'work', 'alpha');
    const team = await runningTeam({ ...TEAM, launch: { alpha: { project: own } } }, own);
    const result = await team.kit.run(['sessions', '--pass'], team.options);
    assertOk(result);
    assert.equal(result.stdout[1], 'CLOSE app-alpha (session alpha): quiet 75 min, its Claude Code holds 1300 MB, 1800 MB committed');
  });

  it('keeps open a running session whose launch.<id>.project is no folder, and goes on for the rest', async () => {
    const gone = resolve('/', 'work', 'gone');
    const team = await runningTeam({ ...TEAM, launch: { alpha: { project: gone } } });
    const result = await team.kit.run(['sessions', '--pass'], team.options);
    assertOk(result);
    assert.deepEqual(result.stdout, [
      'KEEP app-lead (session lead) holds the lead role: teamrig never closes it',
      `KEEP app-alpha (session alpha): the project folder ${gone} does not exist`,
      'AWAY app-bravo (session bravo): not running, and teamrig did not close it',
      'PASS 3 session(s): 0 to close, 0 to reopen, 0 to reopen later, 2 kept open, 0 closed, 1 away; nothing changed',
    ]);
  });

  it('leaves for later the reopen of a closed session whose launch.<id>.project is no folder, and reopens the next', async () => {
    const gone = resolve('/', 'work', 'gone');
    const kit = await closedTeam({ ...TEAM, launch: { alpha: { project: gone } } });
    await hand(kit, 'alpha', 'p1');
    await hand(kit, 'bravo', 'p1');
    const result = await kit.run(['sessions', '--pass'], { probe: new FakePathProbe({ folders: [APP] }), memory: new FakeHostMemory().lists([]) });
    assertOk(result);
    assert.deepEqual(result.stdout, [
      'AWAY app-lead (session lead): not running, and teamrig did not close it',
      `LATER app-alpha (session alpha): work handed to it since its close: T1; the project folder ${gone} does not exist`,
      'REOPEN app-bravo (session bravo): work handed to it since its close: T2',
      'PASS 3 session(s): 0 to close, 1 to reopen, 1 to reopen later, 0 kept open, 0 closed, 1 away; nothing changed',
    ]);
  });

  it('reopens one closed session a pass, the most urgent first, for work handed to it since its close', async () => {
    const kit = await closedTeam();
    await hand(kit, 'alpha', 'p1');
    await hand(kit, 'bravo', 'p1');
    const result = await kit.run(['sessions', '--pass'], { probe: new FakePathProbe({ folders: [APP] }), memory: new FakeHostMemory().lists([]) });
    assertOk(result);
    assert.deepEqual(result.stdout, [
      'AWAY app-lead (session lead): not running, and teamrig did not close it',
      'REOPEN app-alpha (session alpha): work handed to it since its close: T1',
      'LATER app-bravo (session bravo): work handed to it since its close: T2; app-alpha reopens first, one a pass',
      'PASS 3 session(s): 0 to close, 1 to reopen, 1 to reopen later, 0 kept open, 0 closed, 1 away; nothing changed',
    ]);
  });

  it('reopens a closed session for p0 work alone in quiet hours that block, leaving its p1 work to the morning (T2504)', async () => {
    const quietHours = { startUtc: '09:00', endUtc: '11:00', action: 'block' };
    const kit = await closedTeam({ ...TEAM, budget: { enabled: true, quietHours } });
    await hand(kit, 'alpha', 'p1');
    await hand(kit, 'bravo', 'p0');
    const result = await kit.run(['sessions', '--pass'], { probe: new FakePathProbe({ folders: [APP] }), memory: new FakeHostMemory().lists([]) });
    assertOk(result);
    assert.deepEqual(result.stdout, [
      'AWAY app-lead (session lead): not running, and teamrig did not close it',
      'CLOSED app-alpha (session alpha): nothing it can start',
      'REOPEN app-bravo (session bravo): work handed to it since its close: T2',
      'PASS 3 session(s): 0 to close, 1 to reopen, 0 to reopen later, 0 kept open, 1 closed, 1 away; nothing changed',
    ]);
  });

  it('reopens first a session urgent lines wait for, the oldest first, ahead of p1 work, reading no budget for it', async () => {
    const kit = await closedTeam(BUDGETED);
    await hand(kit, 'alpha', 'p1');
    const asks = new WakeAsks(kit.files, join(TEAM_HOME, 'state', 'wake-asks'));
    await asks.post('bravo', { from: 'lead', text: 'the build broke', at: NOW - MINUTE_MS });
    const options = { probe: new FakePathProbe({ folders: [APP] }), memory: new FakeHostMemory().lists([]) };
    const result = await kit.run(['sessions', '--pass'], options);
    assertOk(result);
    assert.deepEqual(result.stdout.slice(1, 3), [
      'LATER app-alpha (session alpha): work handed to it since its close: T1; app-bravo reopens first, one a pass',
      'REOPEN app-bravo (session bravo): an urgent line from lead',
    ]);

    await asks.post('alpha', { from: 'bravo', text: 'and the docs', at: NOW - 2 * MINUTE_MS });
    const older = await kit.run(['sessions', '--pass'], options);
    assertOk(older);
    assert.deepEqual(older.stdout.slice(1, 3), [
      'REOPEN app-alpha (session alpha): an urgent line from bravo',
      'LATER app-bravo (session bravo): an urgent line from lead; app-alpha reopens first, one a pass',
    ]);

    // With no work handed, no budget is read: a rest never holds a reopen for urgent lines.
    const asked = await closedTeam(BUDGETED);
    await new WakeAsks(asked.files, join(TEAM_HOME, 'state', 'wake-asks')).post('bravo', { from: 'lead', text: 'the build broke', at: NOW - MINUTE_MS });
    const unread = new FaultyFiles(asked.files);
    for (const id of ['alpha', 'bravo']) {
      unread.fail('read', join(TEAM_HOME, 'state', 'usage', `${id}.json`), systemError('EACCES', 'EACCES: permission denied'));
    }
    const blind = await asked.run(['sessions', '--pass'], { ...options, files: unread });
    assertOk(blind);
    assert.equal(blind.stdout[2], 'REOPEN app-bravo (session bravo): an urgent line from lead');
  });

  it('leaves a reopen for later when the host has no room, and a session closed with work under the wake priority', async () => {
    const kit = await closedTeam();
    await hand(kit, 'alpha', 'p1');
    await hand(kit, 'bravo', 'p2');
    const memory = new FakeHostMemory().lists([]);
    memory.free = 500;
    const result = await kit.run(['sessions', '--pass'], { probe: new FakePathProbe({ folders: [APP] }), memory });
    assertOk(result);
    assert.match(result.stdout[1] ?? '', /^LATER app-alpha \(session alpha\): work handed to it since its close: T1; no room on the host to reopen app-alpha, counted at /);
    assert.equal(result.stdout[2], 'CLOSED app-bravo (session bravo): nothing it can start');
  });

  it('leaves a reopen for later while the plugin store changed within 30 s, reading no room for it', async () => {
    const kit = await closedTeam();
    await hand(kit, 'alpha', 'p1');
    const list = join(USER_HOME, '.claude', 'plugins', 'installed_plugins.json');
    await kit.files.write(list, JSON.stringify({ version: 2, plugins: {} }));
    const pluginStore = new FakePluginStore().date(list, kit.clock.now() - 10_000);
    const crowded = new FakeHostMemory().lists([]);
    crowded.free = 500;
    const copying = await kit.run(['sessions', '--pass'], { probe: new FakePathProbe({ folders: [APP] }), memory: crowded, pluginStore });
    assertOk(copying);
    assert.equal(copying.stdout[1], 'LATER app-alpha (session alpha): work handed to it since its close: T1; the plugin store changed 10 s ago, under 30 s: an install may still be copying, so the reopen waits for a settled install');

    kit.clock.advance(20_000);
    const settled = await kit.run(['sessions', '--pass'], { probe: new FakePathProbe({ folders: [APP] }), memory: new FakeHostMemory().lists([]), pluginStore });
    assertOk(settled);
    assert.equal(settled.stdout[1], 'REOPEN app-alpha (session alpha): work handed to it since its close: T1');
  });

  it("reads a session's budget only where its rest can change the step: work past p1, or a reopen", async () => {
    const team = await runningTeam(BUDGETED);
    const unreadable = { ...team.options, files: new FaultyFiles(team.kit.files).fail('read', ALPHA_USAGE, systemError('EACCES', 'EACCES: permission denied')) };
    const idle = await team.kit.run(['sessions', '--pass'], unreadable);
    assertOk(idle);
    assert.equal(idle.stdout[1], 'CLOSE app-alpha (session alpha): quiet 75 min, its Claude Code holds 1300 MB, 1800 MB committed');
    await hand(team.kit, 'alpha', 'p2');
    assert.match((await team.kit.run(['sessions', '--pass'], unreadable)).stderr.join('\n'), /EACCES/, 'p2 work weighs only while the budget does not rest it');

    const closed = await closedTeam(BUDGETED);
    const unread = { probe: new FakePathProbe({ folders: [APP] }), memory: new FakeHostMemory().lists([]), files: new FaultyFiles(closed.files).fail('read', ALPHA_USAGE, systemError('EACCES', 'EACCES: permission denied')) };
    const resting = await closed.run(['sessions', '--pass'], unread);
    assertOk(resting);
    assert.equal(resting.stdout[1], 'CLOSED app-alpha (session alpha): nothing it can start');
    await hand(closed, 'alpha', 'p1');
    assert.match((await closed.run(['sessions', '--pass'], unread)).stderr.join('\n'), /EACCES/, 'a rest may hold a reopen back');
  });
});
