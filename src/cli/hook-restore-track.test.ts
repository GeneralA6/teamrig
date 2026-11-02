import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Env } from '../core/home.ts';
import { MS_PER_HOUR } from '../core/time.ts';
import type { RestoreEntry } from '../restore/entry.ts';
import { AUTH_FAILED, loginMarkerPath, parseLoginMarker, type LoginMarker } from '../restore/login.ts';
import { RestoreRegistry, restoreLogPath, restoreSessionsDir } from '../restore/registry.ts';
import { APP, CLAUDE_SESSION, CLI_PID, CliHarness, KIT, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { holdFileLock } from '../testing/held-file-lock.ts';
import { apiErrorLine, promptLine, transcript } from '../testing/transcript-lines.ts';

const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);
const ENTRY_FILE = join(restoreSessionsDir(KIT), `${CLAUDE_SESSION}.json`);
const LAUNCHED: Env = { CLAUDE_PROJECT_DIR: APP, CLAUDE_CODE_ENTRYPOINT: 'cli', TEAMRIG_TEAM: 'app', TEAMRIG_SESSION: 'alpha' };
const MARKER_FILE = loginMarkerPath(KIT);
const TAB = `app/alpha (${CLAUDE_SESSION})`;

function payload(event: string, extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ hook_event_name: event, session_id: CLAUDE_SESSION, cwd: join(APP, 'sub'), transcript_path: TRANSCRIPT, ...extra });
}

async function track(kit: CliHarness, stdin: string, env: Env = LAUNCHED): Promise<CliResult> {
  const result = await kit.run(['hook', 'restore-track'], { stdin, env, sessionProcesses: new FakeSessionProcesses(7000) });
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, [], []], 'a tracker prints nothing and never fails a turn');
  return result;
}

async function entryOf(kit: CliHarness): Promise<RestoreEntry | undefined> {
  return new RestoreRegistry(kit.files, restoreSessionsDir(KIT)).read(CLAUDE_SESSION);
}

async function markerOf(kit: CliHarness): Promise<LoginMarker | undefined> {
  const text = await kit.files.read(MARKER_FILE);
  return text === undefined ? undefined : parseLoginMarker(text);
}

/** The restore log's login lines, each without its time. */
async function loginLines(kit: CliHarness): Promise<string[]> {
  const text = (await kit.files.read(restoreLogPath(KIT))) ?? '';
  return text
    .split('\n')
    .filter((line) => line.includes(' login: '))
    .map((line) => line.slice(line.indexOf(' ') + 1));
}

/** A tab's Claude session id, `index` of a dozen a day-start wake fails at once. */
function tabId(index: number): string {
  return `0123abcd-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`;
}

describe('hook restore-track', () => {
  it('records a session in a turn from its prompt: where it started, its Claude Code, team and session', async () => {
    const kit = new CliHarness();
    await track(kit, payload('UserPromptSubmit', { prompt: 'ship T1' }));
    const entry = await entryOf(kit);
    assert.equal(entry?.state, 'working');
    assert.equal(entry.projectDir, APP, 'the folder Claude Code started in wins over the current one');
    assert.equal(entry.transcriptPath, TRANSCRIPT);
    assert.equal(entry.entrypoint, 'cli');
    assert.equal(entry.pid, 7000);
    assert.deepEqual([entry.team, entry.session], ['app', 'alpha']);
    assert.equal(entry.createdAt, kit.clock.now());
  });

  it('marks it ready at the turn end, and errored after an API error', async () => {
    const kit = new CliHarness();
    await track(kit, payload('UserPromptSubmit'));
    await track(kit, payload('Stop', { stop_hook_active: false }));
    assert.equal((await entryOf(kit))?.state, 'ready');
    await track(kit, payload('StopFailure', { error: 'overloaded' }));
    assert.equal((await entryOf(kit))?.state, 'error');
  });

  it('records a session of no team, in the folder its payload names, and no id the environment garbles', async () => {
    const kit = new CliHarness(null, null);
    await track(kit, payload('SessionStart', { source: 'startup' }), { TEAMRIG_TEAM: 'Bad Team' });
    const entry = await entryOf(kit);
    assert.equal(entry?.projectDir, join(APP, 'sub'));
    assert.deepEqual([entry.team, entry.session, entry.entrypoint], [undefined, undefined, undefined]);
  });

  it("leaves a session in a turn as it was at a compaction's start, which comes mid-turn", async () => {
    const kit = new CliHarness();
    await track(kit, payload('UserPromptSubmit'));
    await track(kit, payload('SessionStart', { source: 'compact' }));
    assert.equal((await entryOf(kit))?.state, 'working');
    await track(kit, payload('SessionStart', { source: 'resume' }));
    assert.equal((await entryOf(kit))?.state, 'ready');
  });

  it('forgets a session at an end the person chose, and stamps any other end', async () => {
    const kit = new CliHarness();
    await track(kit, payload('UserPromptSubmit'));
    await track(kit, payload('SessionEnd', { reason: 'other' }));
    assert.equal((await entryOf(kit))?.endedAt, kit.clock.now());
    await track(kit, payload('SessionEnd', { reason: 'clear' }));
    assert.equal(await kit.files.read(ENTRY_FILE), undefined);
  });

  it('writes nothing for a payload of no session id, an event it does not track, or no folder', async () => {
    const kit = new CliHarness();
    await track(kit, JSON.stringify({ hook_event_name: 'Stop', session_id: '../../x', cwd: APP }));
    await track(kit, payload('PreToolUse', { tool_name: 'Bash' }));
    await track(kit, 'not json');
    await track(kit, JSON.stringify({ hook_event_name: 'Stop', session_id: CLAUDE_SESSION }), {});
    assert.deepEqual(await kit.files.list(restoreSessionsDir(KIT)), []);
  });

  it('lets the turn go on when the registry cannot be written', async () => {
    const kit = new CliHarness();
    const files = new FaultyFiles(kit.files).fail('write', ENTRY_FILE, systemError('EACCES'));
    const result = await kit.run(['hook', 'restore-track'], { stdin: payload('UserPromptSubmit'), env: LAUNCHED, files });
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, [], []]);
    assert.equal(await entryOf(kit), undefined);
  });
});

describe('hook restore-track: the login', () => {
  it('marks the login expired and the tab stuck when a turn ends on Login expired', async () => {
    const kit = new CliHarness();
    await track(kit, payload('StopFailure', { error: AUTH_FAILED }));
    const now = kit.clock.now();
    assert.deepEqual(await markerOf(kit), { expiredAt: now, lastFailAt: now, recoveredAt: undefined, stranded: new Map([[CLAUDE_SESSION, now]]), pagedAt: undefined });
    assert.deepEqual(await loginLines(kit), [`login: expired, ${TAB} ended its turn on Login expired; 1 tab(s) stuck`]);
    assert.equal((await entryOf(kit))?.state, 'error', 'the entry is kept as before');
  });

  it("reads the transcript's failed turn when the payload names no error", async () => {
    const kit = new CliHarness();
    await kit.files.write(TRANSCRIPT, transcript([promptLine('2030-01-08T09:59:50Z'), apiErrorLine('2030-01-08T10:00:00Z', CLAUDE_SESSION)]));
    await track(kit, payload('StopFailure'));
    assert.deepEqual([...((await markerOf(kit))?.stranded.keys() ?? [])], [CLAUDE_SESSION]);
  });

  it('writes no marker for a turn that failed on anything but the login', async () => {
    const kit = new CliHarness();
    await track(kit, payload('StopFailure', { error: 'overloaded' }));
    await kit.files.write(TRANSCRIPT, transcript([apiErrorLine('2030-01-08T10:00:00Z', CLAUDE_SESSION, 'server_error', 'API Error: 500')]));
    await track(kit, payload('StopFailure'));
    await track(kit, payload('Stop'));
    assert.equal(await kit.files.read(MARKER_FILE), undefined);
    assert.deepEqual(await loginLines(kit), []);
  });

  it('keeps one expiry when a dozen tabs fail at once, and logs it once and each other tab after it', async () => {
    const kit = new CliHarness();
    // The tabs' hooks take the marker's lock as this CLI: a holder it sees dead would be taken over, with no exclusion.
    kit.sessionProcesses.add({ pid: CLI_PID, parentPid: 1, name: 'node', commandLine: 'node teamrig hook' });
    const tabs = Array.from({ length: 12 }, (_, index) => tabId(index + 1));
    const start = kit.clock.now();
    const results = await Promise.all(tabs.map(async (tab) => kit.run(['hook', 'restore-track'], { stdin: payload('StopFailure', { session_id: tab, error: AUTH_FAILED }), env: LAUNCHED })));
    assert.deepEqual(results.map((result) => result.code), tabs.map(() => 0));
    const marker = await markerOf(kit);
    assert.equal(marker?.expiredAt, start);
    assert.deepEqual([...marker.stranded.keys()].sort(), tabs);
    const lines = await loginLines(kit);
    assert.deepEqual([lines.filter((line) => line.startsWith('login: expired,')).length, lines.length], [1, 12]);
    assert.match(lines.at(-1) ?? '', /; 12 tab\(s\) stuck$/);
  });

  it("logs the login working again at a later good turn end, and frees that tab", async () => {
    const kit = new CliHarness();
    await track(kit, payload('StopFailure', { error: AUTH_FAILED }));
    kit.clock.advance(6 * MS_PER_HOUR);
    await track(kit, payload('Stop'));
    const marker = await markerOf(kit);
    assert.deepEqual([marker?.recoveredAt, marker?.stranded.size], [kit.clock.now(), 0]);
    assert.equal((await loginLines(kit)).at(-1), `login: works again, ${TAB} answered; 0 tab(s) stuck`);
    await track(kit, payload('Stop'));
    assert.equal((await loginLines(kit)).length, 2, 'a good turn with the login working logs nothing');
  });

  it("updates the entry and exits 0 when the marker's lock stays busy", async () => {
    const kit = new CliHarness();
    await holdFileLock(kit, `${MARKER_FILE}.lock`);
    const result = await kit.run(['hook', 'restore-track'], { stdin: payload('StopFailure', { error: AUTH_FAILED }), env: LAUNCHED });
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, [], []]);
    assert.equal((await entryOf(kit))?.state, 'error');
    assert.equal(await kit.files.read(MARKER_FILE), undefined);
  });

  it('writes the marker when the entry cannot be written', async () => {
    const kit = new CliHarness();
    const files = new FaultyFiles(kit.files).fail('write', ENTRY_FILE, systemError('EACCES'));
    const result = await kit.run(['hook', 'restore-track'], { stdin: payload('StopFailure', { error: AUTH_FAILED }), env: LAUNCHED, files });
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, [], []]);
    assert.equal(await entryOf(kit), undefined);
    assert.equal((await markerOf(kit))?.stranded.has(CLAUDE_SESSION), true);
  });
});
