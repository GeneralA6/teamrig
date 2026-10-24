import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord } from '../core/guards.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';

const SESSIONS = join(TEAM_HOME, 'state', 'sessions');
const AS_ALPHA = { TEAMRIG_SESSION: 'alpha' };
/** The Claude Code session a /clear starts. */
const CLEARED = '0123abcd-0000-4000-8000-00000000000b';

/** The hook, started by Claude Code (6900) itself. */
const UNDER_CLAUDE = (): FakeSessionProcesses => new FakeSessionProcesses(6900);

/** A SessionStart payload; `transcript` undefined leaves out its transcript_path. */
function start(source: string, session: string = CLAUDE_SESSION, transcript?: string): string {
  return JSON.stringify({ session_id: session, cwd: APP, source, ...(transcript === undefined ? {} : { transcript_path: transcript }) });
}

/** The transcript of Claude Code session `session` in a worktree, not the team's project folder. */
function worktreeTranscript(session: string): string {
  return join('/', 'claude', 'projects', 'w-fix', `${session}.jsonl`);
}

/** The line the SessionStart hook shows the user, if any. */
function noticeOf(result: CliResult): string | undefined {
  const parsed: unknown = JSON.parse(result.stdout[0] ?? '');
  assert.ok(isRecord(parsed));
  const notice = parsed['systemMessage'];
  return typeof notice === 'string' ? notice : undefined;
}

describe('the SessionStart hook records where the session started', () => {
  it('records its Claude Code process, session and transcript, and a /clear in that process records the new session', async () => {
    const kit = new CliHarness(TEAM);
    const store = new SessionRecordStore(kit.files, { sessions: SESSIONS });
    const started = start('startup', CLAUDE_SESSION, worktreeTranscript(CLAUDE_SESSION));
    contextOf(await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: started, sessionProcesses: UNDER_CLAUDE() }));
    assert.deepEqual(await store.read('alpha'), { claudePid: 6900, claudeSession: CLAUDE_SESSION, at: '2030-01-08T10:00:00.000Z', transcript: worktreeTranscript(CLAUDE_SESSION) });
    kit.clock.advance(60_000);
    contextOf(await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('clear', CLEARED, worktreeTranscript(CLEARED)), sessionProcesses: UNDER_CLAUDE() }));
    assert.deepEqual(await store.read('alpha'), { claudePid: 6900, claudeSession: CLEARED, at: '2030-01-08T10:01:00.000Z', transcript: worktreeTranscript(CLEARED) });
    kit.clock.advance(60_000);
    contextOf(await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('compact', CLEARED), sessionProcesses: UNDER_CLAUDE() }));
    assert.deepEqual(await store.read('alpha'), { claudePid: 6900, claudeSession: CLEARED, at: '2030-01-08T10:02:00.000Z' }, 'a payload naming no transcript records none');
  });

  it('records nothing for a tab that is no session', async () => {
    const kit = new CliHarness(TEAM);
    contextOf(await kit.run(['hook', 'session-start'], { stdin: start('startup'), sessionProcesses: UNDER_CLAUDE() }));
    assert.deepEqual(kit.files.paths().filter((path) => path.startsWith(SESSIONS)), []);
  });

  it('still starts the session when the record cannot be written, and says why', async () => {
    const kit = new CliHarness(TEAM);
    const files = new FaultyFiles(kit.files).fail('write', join(SESSIONS, 'alpha.json'), systemError('EACCES'));
    const result = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('startup'), sessionProcesses: UNDER_CLAUDE(), files });
    assert.match(contextOf(result), /You are the `alpha` session/);
    assert.match(noticeOf(result) ?? '', /^teamrig could not record the Claude Code process of session alpha \(.*EACCES.*\)\.$/);
  });
});
