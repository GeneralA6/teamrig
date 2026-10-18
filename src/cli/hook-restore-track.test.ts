import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Env } from '../core/home.ts';
import type { RestoreEntry } from '../restore/entry.ts';
import { RestoreRegistry, restoreSessionsDir } from '../restore/registry.ts';
import { APP, CLAUDE_SESSION, CliHarness, KIT, USER_HOME, type CliResult } from '../testing/cli-harness.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';

const TRANSCRIPT = join(USER_HOME, '.claude', 'projects', 'work-app', `${CLAUDE_SESSION}.jsonl`);
const ENTRY_FILE = join(restoreSessionsDir(KIT), `${CLAUDE_SESSION}.json`);
const LAUNCHED: Env = { CLAUDE_PROJECT_DIR: APP, CLAUDE_CODE_ENTRYPOINT: 'cli', TEAMRIG_TEAM: 'app', TEAMRIG_SESSION: 'alpha' };

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
