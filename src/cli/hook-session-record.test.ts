import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readConfigDir } from '../budget/config-dir.ts';
import { isRecord } from '../core/guards.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { APP, CLAUDE_SESSION, CliHarness, contextOf, TEAM, TEAM_HOME, type CliResult } from '../testing/cli-harness.ts';

const SESSIONS = join(TEAM_HOME, 'state', 'sessions');
const CONFIG_DIR_RECORD = join(TEAM_HOME, 'state', 'usage', 'claude-config-dir.json');
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
    assert.equal(await readConfigDir(kit.files, CONFIG_DIR_RECORD), undefined);
  });

  it('records the Claude config dir the session runs in, so another team tells which login the team is on', async () => {
    const kit = new CliHarness(TEAM);
    const workDir = join('/', 'claude-work');
    contextOf(await kit.run(['hook', 'session-start'], { env: { ...AS_ALPHA, CLAUDE_CONFIG_DIR: workDir }, stdin: start('startup'), sessionProcesses: UNDER_CLAUDE() }));
    assert.equal(await readConfigDir(kit.files, CONFIG_DIR_RECORD), workDir);
  });

  it('still starts the session when the record cannot be written, and says why', async () => {
    const kit = new CliHarness(TEAM);
    const files = new FaultyFiles(kit.files).fail('write', join(SESSIONS, 'alpha.json'), systemError('EACCES'));
    const result = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('startup'), sessionProcesses: UNDER_CLAUDE(), files });
    assert.match(contextOf(result), /You are the `alpha` session/);
    assert.match(noticeOf(result) ?? '', /^teamrig could not record the Claude Code process of session alpha \(.*EACCES.*\)\.$/);
  });
});

describe('the SessionStart hook of a session that runs in another Claude Code', () => {
  /** Alpha's record: Claude Code 6800, started an hour before the harness clock. */
  const LIVE = { claudePid: 6800, claudeSession: 'c0', at: '2030-01-08T09:00:00.000Z' };
  const STOP =
    'STOP: session alpha already runs in Claude Code process 6800, so this Claude Code (process 6900) is a second one, which would work beside it on the same tasks; ' +
    "teamrig kept the session's record on the first. Do no work here: tell the user to use that tab and close this one.";

  /** A hook under Claude Code 6900, started by `parent`, beside alpha's Claude Code 6800 when `live`. */
  function host(live: boolean, parent: number = 1, commandLine: string = 'claude') {
    const processes = UNDER_CLAUDE().add({ pid: 6900, parentPid: parent, name: 'claude.exe', commandLine });
    const rows = [{ pid: 6900, parent, bytes: 1, startedMs: Date.parse('2030-01-08T09:59:00Z') }];
    if (!live) {
      return { sessionProcesses: processes, memory: new FakeHostMemory().lists(rows) };
    }
    return {
      sessionProcesses: processes.add({ pid: 6800, parentPid: 1, name: 'claude.exe', commandLine: 'claude' }),
      memory: new FakeHostMemory().lists([{ pid: 6800, parent: 1, bytes: 1, startedMs: Date.parse('2030-01-08T08:59:00Z') }, ...rows]),
    };
  }

  it('keeps the live record and tells this second one, and the user, to stop', async () => {
    const kit = new CliHarness(TEAM);
    const store = new SessionRecordStore(kit.files, { sessions: SESSIONS });
    await store.write('alpha', LIVE);
    const result = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('startup'), ...host(true) });
    assert.ok(contextOf(result).includes(STOP));
    assert.equal(noticeOf(result), STOP);
    assert.deepEqual(await store.read('alpha'), LIVE);
  });

  it('keeps the live record silently for a Claude Code that session started, such as a claude -p', async () => {
    const kit = new CliHarness(TEAM);
    const store = new SessionRecordStore(kit.files, { sessions: SESSIONS });
    await store.write('alpha', LIVE);
    const result = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('startup'), ...host(true, 6800) });
    assert.ok(!contextOf(result).includes('STOP:'));
    assert.equal(noticeOf(result), undefined);
    assert.deepEqual(await store.read('alpha'), LIVE);
  });

  const FORK = `/opt/claude/versions/2.1 --session-id ${CLEARED} --fork-session --resume ${worktreeTranscript('c0')}`;

  it('takes a fork of the recorded session as the same one: no stop, the record kept', async () => {
    const kit = new CliHarness(TEAM);
    const store = new SessionRecordStore(kit.files, { sessions: SESSIONS });
    await store.write('alpha', LIVE);
    const result = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('clear', CLEARED), ...host(true, 1, FORK) });
    assert.ok(!contextOf(result).includes('STOP:'));
    assert.equal(noticeOf(result), undefined);
    assert.deepEqual(await store.read('alpha'), LIVE);
    const byId = FORK.replace(worktreeTranscript('c0'), 'c0');
    assert.equal(noticeOf(await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('clear', CLEARED), ...host(true, 1, byId) })), undefined);
  });

  it('stops a fork of another session, and a start that only names --fork-session', async () => {
    const kit = new CliHarness(TEAM);
    const store = new SessionRecordStore(kit.files, { sessions: SESSIONS });
    await store.write('alpha', LIVE);
    const other = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('clear', CLEARED), ...host(true, 1, FORK.replace('c0.jsonl', 'zz.jsonl')) });
    assert.equal(noticeOf(other), STOP);
    const plain = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('startup'), ...host(true, 1, '/x/claude --fork-session') });
    assert.equal(noticeOf(plain), STOP);
  });

  describe('a background job', () => {
    /** The Claude Code session the tab handed its conversation to (`/bg`), as Claude Code's background host runs it. */
    const JOB = '0123abcd-0000-4000-8000-0000000000b9';
    const TAB_TRANSCRIPT = worktreeTranscript('c0');
    const TURN = JSON.stringify({ type: 'assistant', sessionId: 'c0', entrypoint: 'cli' });
    const HANDED = (to: string) => JSON.stringify({ type: 'continued-in', sessionId: 'c0', continuedInSessionId: to });
    const HOST_LINE = (session: string) =>
      `claude bg-pty-host --bg-pty-host /tmp/cc-daemon-1000/3c2b/pty/0123abcd.sock 77 25 -- /opt/claude/versions/2.1 --session-id ${session} --fork-session --resume ${TAB_TRANSCRIPT}`;

    /**
     * Alpha's live tab (6800, its record naming its transcript) beside the hook's Claude Code 6900, which runs `jobLine`
     * under Claude Code's background host (6950, `hostLine`) when one is given, else under init. The host's daemon was
     * replaced, so init adopted it: neither is in the tab's tree. The tab's transcript ends with `tail`.
     */
    async function beside(kit: CliHarness, tail: readonly string[], hostLine: string | undefined, jobLine = 'claude') {
      await new SessionRecordStore(kit.files, { sessions: SESSIONS }).write('alpha', { ...LIVE, transcript: TAB_TRANSCRIPT });
      await kit.files.write(TAB_TRANSCRIPT, `${tail.join('\n')}\n`);
      const live = host(true, hostLine === undefined ? 1 : 6950, jobLine);
      if (hostLine !== undefined) {
        live.sessionProcesses.add({ pid: 6950, parentPid: 1, name: 'claude', commandLine: hostLine });
      }
      return live;
    }

    it('is the tab its conversation was handed to: a /clear there keeps the record silently', async () => {
      const kit = new CliHarness(TEAM);
      const store = new SessionRecordStore(kit.files, { sessions: SESSIONS });
      const result = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('clear', CLEARED), ...(await beside(kit, [TURN, HANDED(JOB)], HOST_LINE(JOB))) });
      assert.equal(noticeOf(result), undefined);
      assert.ok(!contextOf(result).includes('STOP:'));
      assert.deepEqual(await store.read('alpha'), { ...LIVE, transcript: TAB_TRANSCRIPT });
    });

    it('takes the session from the job itself when its host names none', async () => {
      const kit = new CliHarness(TEAM);
      const hostLine = 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-1000/3c2b/pty/0123abcd.sock 77 25';
      const result = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('clear', CLEARED), ...(await beside(kit, [TURN, HANDED(JOB)], hostLine, `/x/claude --session-id=${JOB}`)) });
      assert.equal(noticeOf(result), undefined);
    });

    it('stops a background job of another session, and one the tab took its conversation back from', async () => {
      const kit = new CliHarness(TEAM);
      const other = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('clear', CLEARED), ...(await beside(kit, [TURN, HANDED('0123abcd-0000-4000-8000-0000000000c1')], HOST_LINE(JOB))) });
      assert.equal(noticeOf(other), STOP);
      const back = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('clear', CLEARED), ...(await beside(kit, [TURN, HANDED(JOB), TURN], HOST_LINE(JOB))) });
      assert.equal(noticeOf(back), STOP);
      const never = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('clear', CLEARED), ...(await beside(kit, [TURN], HOST_LINE(JOB))) });
      assert.equal(noticeOf(never), STOP);
    });

    it('stops a second Claude Code that runs as the handed-off session but under no background host', async () => {
      const kit = new CliHarness(TEAM);
      const result = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('startup'), ...(await beside(kit, [TURN, HANDED(JOB)], undefined, `/x/claude --session-id ${JOB}`)) });
      assert.equal(noticeOf(result), STOP);
    });

    it('stops it when the record names no transcript, or the host cannot list its processes', async () => {
      const kit = new CliHarness(TEAM);
      const untracked = await beside(kit, [TURN, HANDED(JOB)], HOST_LINE(JOB));
      await new SessionRecordStore(kit.files, { sessions: SESSIONS }).write('alpha', LIVE);
      assert.equal(noticeOf(await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('clear', CLEARED), ...untracked })), STOP);
      const unlisted = await beside(kit, [TURN, HANDED(JOB)], HOST_LINE(JOB));
      unlisted.sessionProcesses.hideLineage();
      assert.equal(noticeOf(await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('clear', CLEARED), ...unlisted })), STOP);
    });
  });

  it('records this one once the recorded Claude Code ended', async () => {
    const kit = new CliHarness(TEAM);
    const store = new SessionRecordStore(kit.files, { sessions: SESSIONS });
    await store.write('alpha', LIVE);
    const result = await kit.run(['hook', 'session-start'], { env: AS_ALPHA, stdin: start('startup'), ...host(false) });
    assert.equal(noticeOf(result), undefined);
    assert.deepEqual(await store.read('alpha'), { claudePid: 6900, claudeSession: CLAUDE_SESSION, at: '2030-01-08T10:00:00.000Z' });
  });
});
