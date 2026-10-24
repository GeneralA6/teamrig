import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectTranscriptPath } from '../budget/discover.ts';
import type { JsonRecord } from '../core/guards.ts';
import { SessionLog } from '../sessions/log.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe } from '../testing/fake-processes.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { EXIT } from './runtime.ts';

const MB = 2 ** 20;
const MINUTE_MS = 60_000;
/** The harness clock's now. */
const NOW = Date.parse('2030-01-08T10:00:00.000Z');
const SESSIONS = join(TEAM_HOME, 'state', 'sessions');
const LOG = join(TEAM_HOME, 'state', 'session-log.jsonl');
const TRANSCRIPT = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), APP, CLAUDE_SESSION);
const TAB = { pid: 8000, parentPid: 7900, name: 'powershell.exe', commandLine: `powershell -NoExit -Command claude --resume ${CLAUDE_SESSION}` };
const CLAUDE = { pid: 8100, parentPid: TAB.pid, name: 'claude.exe', commandLine: `claude --resume ${CLAUDE_SESSION}` };
/** Alpha's Claude Code and an MCP server it runs: 1300 MB. */
const ROWS = [
  { pid: CLAUDE.pid, parent: TAB.pid, bytes: 1100 * MB },
  { pid: 8101, parent: CLAUDE.pid, bytes: 200 * MB },
];

/** A transcript line the way Claude Code writes an assistant reply, with `tokens` of context. */
function reply(tokens: number): string {
  return `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, output_tokens: 50 } } })}\n`;
}

/** A subagent started in the background `minutesAgo`, with no notification that it ended. */
function backgroundAgent(minutesAgo: number): string {
  const call = { type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: {} }] } };
  const started = {
    type: 'user',
    timestamp: new Date(NOW - minutesAgo * MINUTE_MS).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'started' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1' },
  };
  return `${JSON.stringify(call)}\n${JSON.stringify(started)}\n`;
}

interface Alpha {
  readonly kit: CliHarness;
  readonly processes: FakeSessionProcesses;
  readonly options: RunOptions;
}

/**
 * A team (`config`) whose alpha runs in Claude Code 8100 in tab 8000 since 08:00, its transcript `transcript`, last
 * written `idleMinutes` ago: at `recorded`, the path its start recorded, else in the project folder of a record naming none.
 */
async function runningAlpha(idleMinutes = 75, transcript = reply(40_000), recorded?: string, config: JsonRecord = TEAM): Promise<Alpha> {
  const kit = new CliHarness(config);
  const record = { claudePid: CLAUDE.pid, claudeSession: CLAUDE_SESSION, at: '2030-01-08T08:00:00.000Z' };
  await new SessionRecordStore(kit.files, { sessions: SESSIONS }).write('alpha', recorded === undefined ? record : { ...record, transcript: recorded });
  const path = recorded ?? TRANSCRIPT;
  await kit.files.write(path, transcript);
  const processes = new FakeSessionProcesses().add(TAB).add(CLAUDE);
  const options: RunOptions = {
    platform: 'win32',
    probe: new FakePathProbe({ folders: [APP] }),
    memory: new FakeHostMemory().lists(ROWS),
    sessionProcesses: processes,
    transcripts: new MemoryTranscripts({ [path]: transcript }, NOW - idleMinutes * MINUTE_MS),
  };
  return { kit, processes, options };
}

function close(alpha: Alpha, args: readonly string[]): Promise<CliResult> {
  return alpha.kit.run(['close', ...args], alpha.options);
}

/** A refusal prints `REFUSED <why>` and exits 2. */
function assertRefused(result: CliResult, reason: RegExp): void {
  assert.equal(result.code, EXIT.refused, [...result.stdout, ...result.stderr].join('\n'));
  assert.match(result.stdout.join('\n'), reason);
}

describe('teamrig close', () => {
  it('shows the close of an idle session, then with --yes ends its tab and logs what it freed', async () => {
    const alpha = await runningAlpha();
    const preview = await close(alpha, ['alpha', '--session', 'lead']);
    assert.equal(preview.code, 0, preview.stderr.join('\n'));
    assert.deepEqual(preview.stdout, [
      `CLOSE app-alpha (session alpha): quiet 75 min, its Claude Code holds 1300 MB; teamrig open app-alpha resumes Claude Code session ${CLAUDE_SESSION}. Run again with --yes to close it`,
    ]);
    assert.deepEqual(alpha.processes.ends, [], 'the preview ends nothing');
    assert.equal(alpha.kit.files.get(LOG), undefined);

    const closed = await close(alpha, ['alpha', '--yes', '--session', 'lead']);
    assert.equal(closed.code, 0, closed.stderr.join('\n'));
    assert.deepEqual(closed.stdout, ['CLOSED app-alpha (session alpha): quiet 75 min, its Claude Code holds 1300 MB, now free; teamrig open app-alpha resumes it']);
    assert.deepEqual(alpha.processes.ends, [{ pid: TAB.pid, how: 'ask' }], 'it ends the tab, which ends its Claude Code');
    assert.equal(alpha.processes.alive(CLAUDE.pid), false);
    assert.deepEqual((await new SessionLog(alpha.kit.files, LOG).read()).records, [
      { kind: 'close', session: 'alpha', by: 'lead', at: new Date(alpha.kit.clock.now()).toISOString(), claudeSession: CLAUDE_SESSION, idleMinutes: 75, freedMb: 1300 },
    ]);
  });

  it('measures a session at the transcript its start recorded, in whatever folder its tab runs', async () => {
    const worktree = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), join(APP, '.worktrees', 'fix'), CLAUDE_SESSION);
    const alpha = await runningAlpha(75, reply(40_000), worktree);
    const preview = await close(alpha, ['alpha', '--session', 'lead']);
    assert.equal(preview.code, 0, [...preview.stdout, ...preview.stderr].join('\n'));
    assert.match(preview.stdout[0] ?? '', /^CLOSE app-alpha \(session alpha\): quiet 75 min, its Claude Code holds 1300 MB;/);

    const gone = { ...alpha, options: { ...alpha.options, transcripts: new MemoryTranscripts() } };
    const unknown = await close(gone, ['alpha', '--yes', '--session', 'lead']);
    assertRefused(unknown, /has no transcript of Claude Code session \S+ at \S+fix\S+, so its idle time is unknown/);
    assert.deepEqual(alpha.processes.ends, []);
  });

  it('closes only for the lead, and never the lead itself or a session that does not run', async () => {
    const alpha = await runningAlpha();
    assertRefused(await close(alpha, ['alpha', '--yes', '--session', 'bravo']), /only the lead closes a session/);
    assertRefused(await close(alpha, ['lead', '--yes', '--session', 'lead']), /lead \(session lead\) holds the lead role: teamrig never closes it/);
    assertRefused(await close(alpha, ['bravo', '--yes', '--session', 'lead']), /bravo \(session bravo\) is not running: nothing to close/);
    const kept = await runningAlpha(75, reply(40_000), undefined, { ...TEAM, open: { idle: { keepOpen: ['alpha'] } } });
    assertRefused(await close(kept, ['alpha', '--yes', '--session', 'lead']), /alpha \(session alpha\) is in open\.idle\.keepOpen: teamrig never closes it/);
    assert.deepEqual(kept.processes.ends, []);
    const unlisted = await close({ ...alpha, options: { ...alpha.options, memory: new FakeHostMemory().lists(undefined) } }, ['alpha', '--yes', '--session', 'lead']);
    assertRefused(unlisted, /could not list the host's processes/);
    assert.deepEqual(alpha.processes.ends, []);
  });

  it('keeps open a session with work it can start, one quiet too briefly, and one running background work', async () => {
    const busy = await runningAlpha();
    const added = await busy.kit.run(['add', '--title', 'Ship the release', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
    assert.equal(added.code, 0, added.stderr.join('\n'));
    assertRefused(await close(busy, ['alpha', '--yes', '--session', 'lead']), /alpha \(session alpha\) has work it can start \(T\d+\)/);

    assertRefused(await close(await runningAlpha(30), ['alpha', '--yes', '--session', 'lead']), /quiet 30 min; it closes after 60 \(open\.headroom\.closeIdleMinutes\)/);

    const helping = await runningAlpha(75, `${reply(40_000)}${backgroundAgent(80)}${reply(40_000)}`);
    assertRefused(await close(helping, ['alpha', '--yes', '--session', 'lead']), /still runs background work its transcript shows/);
    for (const kept of [busy, helping]) {
      assert.deepEqual(kept.processes.ends, []);
      assert.deepEqual(kept.processes.described, [], 'a session the cheap checks keep costs no look at its process');
    }
  });

  it('keeps open a session at a tool call, one that put a decision to the person, and one whose time wait ends soon', async () => {
    const call = { type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } };
    const calling = await runningAlpha(75, `${reply(40_000)}${JSON.stringify(call)}\n`);
    assertRefused(await close(calling, ['alpha', '--yes', '--session', 'lead']), /alpha \(session alpha\) is at a tool call \(running, or waiting on a permission or an answer\)/);

    const question = { type: 'assistant', uuid: 'a1', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Two ways.\nDecision needed: a or b?' }] } };
    const asking = await runningAlpha(75, `${reply(40_000)}${JSON.stringify(question)}\n`);
    assertRefused(await close(asking, ['alpha', '--yes', '--session', 'lead']), /alpha \(session alpha\) put a decision to the person and waits for the answer/);

    const waiting = await runningAlpha();
    const added = await waiting.kit.run(['add', '--title', 'Ship the release', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
    assert.equal(added.code, 0, added.stderr.join('\n'));
    const set = await waiting.kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'time:2030-01-08 10:20', '--note', 'after the window', '--session', 'alpha']);
    assert.equal(set.code, 0, set.stderr.join('\n'));
    assertRefused(await close(waiting, ['alpha', '--yes', '--session', 'lead']), /alpha \(session alpha\) waits until .+ on T1, under 30 min away/);
    for (const kept of [calling, asking, waiting]) {
      assert.deepEqual(kept.processes.ends, []);
    }
  });

  it('keeps open a session too big to resume, and one whose shells the end would cut off', async () => {
    const big = await runningAlpha(75, reply(400_000));
    assertRefused(await close(big, ['alpha', '--yes', '--session', 'lead']), /could not be resumed once closed \(.+\); retire it with its handover instead/);

    const shelled = await runningAlpha();
    shelled.processes.add({ pid: 8200, parentPid: CLAUDE.pid, name: 'bash.exe', commandLine: 'bash -c npm test' });
    assertRefused(await close(shelled, ['alpha', '--yes', '--session', 'lead']), /would also end the background shells it runs \(pid 8200\)/);
    assert.deepEqual(shelled.processes.ends, []);
  });

  it('logs nothing when its tab outlives the end', async () => {
    const alpha = await runningAlpha();
    alpha.processes.failEnd(TAB.pid, 'access denied');
    assertRefused(await close(alpha, ['alpha', '--yes', '--session', 'lead']), /alpha \(session alpha\) was not closed: could not end process 8000: access denied/);
    assert.equal(alpha.kit.files.get(LOG), undefined);
  });
});
