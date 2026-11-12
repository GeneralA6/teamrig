import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { projectTranscriptPath } from '../budget/discover.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { MeetingSchedule, type ScheduledMeeting } from '../meeting/schedule.ts';
import type { RestoreEntry } from '../restore/entry.ts';
import { RestoreRegistry, restoreSessionsDir } from '../restore/registry.ts';
import { SessionLog } from '../sessions/log.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { HOLDING_BUDGET, holdAlpha } from '../testing/budget-hold.ts';
import { APP, CLAUDE_SESSION, CliHarness, KIT, TEAM, TEAM_HOME, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { ok } from '../testing/hired-team.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe } from '../testing/fake-processes.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { WakeAsks } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

const MB = 2 ** 20;
const MINUTE_MS = 60_000;
/** The harness clock's now. */
const NOW = Date.parse('2030-01-08T10:00:00.000Z');
const SESSIONS = join(TEAM_HOME, 'state', 'sessions');
/** Alpha's transcript in the project folder, where `teamrig open` resumes it. */
const TRANSCRIPT = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), APP, CLAUDE_SESSION);
const LOG = join(TEAM_HOME, 'state', 'session-log.jsonl');
const LEAD_TAB = '0123abcd-0000-4000-8000-0000000000d4';
const TAB = { pid: 8000, parentPid: 7900, name: 'powershell.exe', commandLine: `powershell -NoExit -Command claude --resume ${CLAUDE_SESSION}` };
const CLAUDE = { pid: 8100, parentPid: TAB.pid, name: 'claude.exe', commandLine: `claude --resume ${CLAUDE_SESSION}` };
/** Alpha's Claude Code and an MCP server it runs: 1300 MB. */
const ROWS = [
  { pid: CLAUDE.pid, parent: TAB.pid, bytes: 1100 * MB },
  { pid: 8101, parent: CLAUDE.pid, bytes: 200 * MB },
];

/**
 * A transcript line the way Claude Code writes an assistant reply, with `tokens` of context, stamped `minutesAgo` and
 * run in folder `cwd` when given.
 */
function reply(tokens: number, minutesAgo?: number, cwd?: string): string {
  const stamp = minutesAgo === undefined ? {} : { timestamp: new Date(NOW - minutesAgo * MINUTE_MS).toISOString() };
  const ran = cwd === undefined ? {} : { cwd };
  return `${JSON.stringify({ type: 'assistant', isSidechain: false, ...stamp, ...ran, message: { role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, output_tokens: 50 } } })}\n`;
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
 * written `idleMinutes` ago: at `recorded`, the path its start recorded, else, for a record naming none, in the
 * project folder `project` (the pointer's, else alpha's own `launch.alpha.project`).
 */
async function runningAlpha(idleMinutes = 75, transcript = reply(40_000), recorded?: string, config: JsonRecord = TEAM, project = APP): Promise<Alpha> {
  const kit = new CliHarness(project === APP ? config : { ...config, launch: { alpha: { project } } });
  const record = { claudePid: CLAUDE.pid, claudeSession: CLAUDE_SESSION, at: '2030-01-08T08:00:00.000Z' };
  await new SessionRecordStore(kit.files, { sessions: SESSIONS }).write('alpha', recorded === undefined ? record : { ...record, transcript: recorded });
  const path = recorded ?? projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), project, CLAUDE_SESSION);
  await kit.files.write(path, transcript);
  const processes = new FakeSessionProcesses().add(TAB).add(CLAUDE);
  const options: RunOptions = {
    platform: 'win32',
    probe: new FakePathProbe({ folders: [APP, project] }),
    memory: new FakeHostMemory().lists(ROWS),
    sessionProcesses: processes,
    transcripts: new MemoryTranscripts({ [path]: transcript }, NOW - idleMinutes * MINUTE_MS),
  };
  return { kit, processes, options };
}

function close(alpha: Alpha, args: readonly string[]): Promise<CliResult> {
  return alpha.kit.run(['close', ...args], alpha.options);
}

const OTHER_SESSION = '0123abcd-0000-4000-8000-0000000000e5';

/** The kit home's restore registry, holding an entry for alpha's Claude Code session and one for another session. */
async function recordedForRestore(alpha: Alpha): Promise<RestoreRegistry> {
  const registry = new RestoreRegistry(alpha.kit.files, restoreSessionsDir(KIT));
  for (const claudeSession of [CLAUDE_SESSION, OTHER_SESSION]) {
    const entry: RestoreEntry = {
      claudeSession,
      projectDir: APP,
      transcriptPath: undefined,
      entrypoint: 'cli',
      sessionKind: undefined,
      pid: undefined,
      team: 'app',
      session: undefined,
      state: 'ready',
      createdAt: NOW - 120 * MINUTE_MS,
      updatedAt: NOW - 75 * MINUTE_MS,
      restoreAttempts: 0,
      restoredAt: undefined,
      endedAt: undefined,
      endReason: undefined,
    };
    await registry.write(entry);
  }
  return registry;
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
      { kind: 'close', session: 'alpha', by: 'lead', at: new Date(alpha.kit.clock.now()).toISOString(), claudeSession: CLAUDE_SESSION, idleMinutes: 75, freedMb: 1300, folder: APP },
    ]);
  });

  it('closes a session that started in a worktree, and logs that folder for its reopen to resume it in (T1408)', async () => {
    const fix = join(APP, '.claude', 'worktrees', 'fix');
    const filed = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), fix, CLAUDE_SESSION);
    const alpha = await runningAlpha(75, reply(40_000, undefined, fix), filed);
    const closed = await close(alpha, ['alpha', '--yes', '--session', 'lead']);
    assert.equal(closed.code, 0, [...closed.stdout, ...closed.stderr].join('\n'));
    assert.deepEqual(alpha.processes.ends, [{ pid: TAB.pid, how: 'ask' }]);
    assert.deepEqual((await new SessionLog(alpha.kit.files, LOG).read()).records, [
      { kind: 'close', session: 'alpha', by: 'lead', at: new Date(alpha.kit.clock.now()).toISOString(), claudeSession: CLAUDE_SESSION, idleMinutes: 75, freedMb: 1300, folder: fix },
    ]);
  });

  it('measures a session at the transcript its start recorded, and keeps open one filed under a folder it never ran in', async () => {
    const worktree = projectTranscriptPath(join(USER_HOME, '.claude', 'projects'), join(APP, '.worktrees', 'fix'), CLAUDE_SESSION);
    const alpha = await runningAlpha(75, reply(40_000), worktree);
    assertRefused(
      await close(alpha, ['alpha', '--yes', '--session', 'lead']),
      /alpha \(session alpha\) could not be resumed once closed \(its transcript is in \S+fix, the project folder of neither \S+ nor a folder it ran in\)/,
    );
    assert.deepEqual(alpha.processes.ends, [], 'open would not find it from any folder');
    const recorded = await close(await runningAlpha(75, reply(40_000), TRANSCRIPT), ['alpha', '--session', 'lead']);
    assert.match(recorded.stdout[0] ?? '', /^CLOSE app-alpha \(session alpha\): quiet 75 min/, [...recorded.stdout, ...recorded.stderr].join('\n'));

    // A start before records named the transcript: it is found in whatever folder Claude Code filed it.
    const unrecorded = await runningAlpha();
    await unrecorded.kit.files.write(worktree, reply(40_000));
    const elsewhere = { ...unrecorded, options: { ...unrecorded.options, transcripts: new MemoryTranscripts({ [worktree]: reply(40_000) }, NOW - 75 * MINUTE_MS) } };
    assertRefused(await close(elsewhere, ['alpha', '--yes', '--session', 'lead']), /could not be resumed once closed \(its transcript is in \S+fix,/);
    const nowhere = { ...unrecorded, options: { ...unrecorded.options, transcripts: new MemoryTranscripts() } };
    assertRefused(await close(nowhere, ['alpha', '--yes', '--session', 'lead']), /has no transcript of Claude Code session \S+ in any project folder, so its idle time is unknown/);

    const gone = { ...alpha, options: { ...alpha.options, transcripts: new MemoryTranscripts() } };
    const unknown = await close(gone, ['alpha', '--yes', '--session', 'lead']);
    assertRefused(unknown, /has no transcript of Claude Code session \S+ in any project folder, so its idle time is unknown/);
    assert.deepEqual(alpha.processes.ends, []);
  });

  it('finds a session by its id once its transcript left the folder its start recorded, and resumes it where it now is (T1357)', async () => {
    const projects = join(USER_HOME, '.claude', 'projects');
    const moved = join(APP, '.claude', 'worktrees', 'moved');
    const alpha = await runningAlpha(75, reply(40_000, undefined, moved), projectTranscriptPath(projects, moved, CLAUDE_SESSION));
    const started = projectTranscriptPath(projects, join(APP, '.claude', 'worktrees', 'started'), CLAUDE_SESSION);
    await new SessionRecordStore(alpha.kit.files, { sessions: SESSIONS }).write('alpha', { claudePid: CLAUDE.pid, claudeSession: CLAUDE_SESSION, at: '2030-01-08T08:00:00.000Z', transcript: started });
    const closed = await close(alpha, ['alpha', '--yes', '--session', 'lead']);
    assert.equal(closed.code, 0, [...closed.stdout, ...closed.stderr].join('\n'));
    assert.deepEqual(alpha.processes.ends, [{ pid: TAB.pid, how: 'ask' }]);
    assert.deepEqual((await new SessionLog(alpha.kit.files, LOG).read()).records, [
      { kind: 'close', session: 'alpha', by: 'lead', at: new Date(alpha.kit.clock.now()).toISOString(), claudeSession: CLAUDE_SESSION, idleMinutes: 75, freedMb: 1300, folder: moved },
    ]);
  });

  it("reads the last session from the session's own project folder", async () => {
    const own = resolve('/', 'work', 'alpha');
    const preview = await close(await runningAlpha(75, reply(40_000), undefined, TEAM, own), ['alpha', '--session', 'lead']);
    assert.equal(preview.code, 0, preview.stdout.join('\n'));
    assert.match(preview.stdout[0] ?? '', /^CLOSE app-alpha \(session alpha\): quiet 75 min, its Claude Code holds 1300 MB; /);
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

  it("measures the quiet time from the tab's last own entry, not the file, which changes with none (T1417)", async () => {
    const away = `${JSON.stringify({ type: 'system', subtype: 'away_summary', timestamp: new Date(NOW - 50 * MINUTE_MS).toISOString() })}\n`;
    const touched = await runningAlpha(2, `${reply(40_000, 75)}${away}`);
    const preview = await close(touched, ['alpha', '--session', 'lead']);
    assert.equal(preview.code, 0, [...preview.stdout, ...preview.stderr].join('\n'));
    assert.match(preview.stdout[0] ?? '', /^CLOSE app-alpha \(session alpha\): quiet 75 min, /);
    assertRefused(await close(await runningAlpha(2, `${reply(40_000, 30)}${away}`), ['alpha', '--yes', '--session', 'lead']), /quiet 30 min; it closes after 60/);
  });

  it('weighs work as its budget lets it start it: one the budget holds closes with p1 work, and stays open for p0 (T1159)', async () => {
    const held = await runningAlpha(75, reply(40_000), undefined, { ...TEAM, budget: HOLDING_BUDGET });
    await holdAlpha(held.kit, CLAUDE_SESSION, LEAD_TAB);
    ok(await held.kit.run(['add', '--title', 'Ship the release', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--session', 'lead']));
    const preview = await close(held, ['alpha', '--session', 'lead']);
    assert.match(preview.stdout[0] ?? '', /^CLOSE app-alpha \(session alpha\): quiet 75 min/, [...preview.stdout, ...preview.stderr].join('\n'));
    ok(await held.kit.run(['add', '--title', 'Stop the outage', '--description', 'what and why', '--priority', 'p0', '--owner', 'alpha', '--session', 'lead']));
    assertRefused(await close(held, ['alpha', '--yes', '--session', 'lead']), /alpha \(session alpha\) has work it can start \(T2\)/);
    assert.deepEqual(held.processes.ends, []);
  });

  it('closes a session with p1 work in quiet hours that block, and keeps it open for p0 (T2504)', async () => {
    const quietHours = { startUtc: '09:00', endUtc: '11:00', action: 'block' };
    const quiet = await runningAlpha(75, reply(40_000), undefined, { ...TEAM, budget: { enabled: true, quietHours } });
    ok(await quiet.kit.run(['add', '--title', 'Ship the release', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--session', 'lead']));
    const preview = await close(quiet, ['alpha', '--session', 'lead']);
    assert.match(preview.stdout[0] ?? '', /^CLOSE app-alpha \(session alpha\): quiet 75 min/, [...preview.stdout, ...preview.stderr].join('\n'));
    ok(await quiet.kit.run(['add', '--title', 'Stop the outage', '--description', 'what and why', '--priority', 'p0', '--owner', 'alpha', '--session', 'lead']));
    assertRefused(await close(quiet, ['alpha', '--yes', '--session', 'lead']), /alpha \(session alpha\) has work it can start \(T2\)/);
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

  it("drops the closed session's restore entry, so a reboot's restore does not reopen it, and keeps every other (T1425)", async () => {
    const alpha = await runningAlpha();
    const registry = await recordedForRestore(alpha);
    const closed = await close(alpha, ['alpha', '--yes', '--session', 'lead']);
    assert.equal(closed.code, 0, closed.stderr.join('\n'));
    assert.equal(await registry.read(CLAUDE_SESSION), undefined);
    assert.equal((await registry.read(OTHER_SESSION))?.claudeSession, OTHER_SESSION);
  });

  it('still closes, and warns, when the restore entry cannot be dropped (T1425)', async () => {
    const alpha = await runningAlpha();
    const registry = await recordedForRestore(alpha);
    const files = new FaultyFiles(alpha.kit.files).fail('remove', registry.pathOf(CLAUDE_SESSION), systemError('EACCES', 'EACCES: permission denied'));
    const closed = await alpha.kit.run(['close', 'alpha', '--yes', '--session', 'lead'], { ...alpha.options, files });
    assert.equal(closed.code, 0, closed.stderr.join('\n'));
    assert.deepEqual(closed.stderr, ["WARN the restore entry of alpha was not dropped, so a reboot's restore may reopen it: EACCES: permission denied"]);
    assert.ok(alpha.kit.files.get(LOG) !== undefined, 'the close is logged');
  });

  it('logs nothing and keeps its restore entry when its tab outlives the end', async () => {
    const alpha = await runningAlpha();
    const registry = await recordedForRestore(alpha);
    alpha.processes.failEnd(TAB.pid, 'access denied');
    assertRefused(await close(alpha, ['alpha', '--yes', '--session', 'lead']), /alpha \(session alpha\) was not closed: could not end process 8000: access denied/);
    assert.equal(alpha.kit.files.get(LOG), undefined);
    assert.equal((await registry.read(CLAUDE_SESSION))?.claudeSession, CLAUDE_SESSION);
  });
});

const PASS_LOG = join(TEAM_HOME, 'state', 'idle-pass.jsonl');
const LEAD_INBOX = join(TEAM_HOME, 'state', 'inbox', 'lead.md');
const ASKS = join(TEAM_HOME, 'state', 'wake-asks');
const MEETINGS = join(TEAM_HOME, 'state', 'meetings.jsonl');

/** A team that wakes a session for p1 work only. */
const WAKES_P1: JsonRecord = { ...TEAM, wake: { priority: 1 } };
const CHARGE = { usedMb: 85_300, limitMb: 100_700 };

/** Books the owner's meeting M1 with alpha into the team's schedule, as `meeting book` and `meeting start` leave it. */
async function bookMeeting(alpha: Alpha, fields: Pick<ScheduledMeeting, 'status' | 'changedAt'> & Partial<Pick<ScheduledMeeting, 'session' | 'with'>>): Promise<void> {
  const meeting: ScheduledMeeting = { id: 'M1', at: NOW - 70 * MINUTE_MS, minutes: 30, session: 'alpha', with: [], tasks: [], about: 'the release plan', brief: null, notifiedAt: null, by: 'lead', note: null, ...fields };
  await new MeetingSchedule(alpha.kit.files, MEETINGS).write(meeting, NOW);
}

function idleClose(alpha: Alpha): Promise<CliResult> {
  return alpha.kit.run(['idle-close', 'alpha', '--team', 'app', '--project', APP], alpha.options);
}

/** The pass log's act lines, without their time. */
function actsOf(alpha: Alpha): JsonRecord[] {
  return (alpha.kit.files.get(PASS_LOG) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      assert.ok(isRecord(parsed), line);
      return Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'at'));
    });
}

describe('teamrig idle-close', () => {
  it('closes an idle session as the idle pass, and logs the act with the commit charge before and after', async () => {
    const alpha = await runningAlpha(75, reply(40_000), undefined, WAKES_P1);
    const charged = { ...alpha, options: { ...alpha.options, memory: new FakeHostMemory().lists(ROWS, CHARGE) } };
    const closed = await idleClose(charged);
    assert.equal(closed.code, 0, closed.stderr.join('\n'));
    const line = 'CLOSED app-alpha (session alpha): quiet 75 min, its Claude Code holds 1300 MB, now free';
    assert.deepEqual(closed.stdout, [line]);
    assert.deepEqual(alpha.processes.ends, [{ pid: TAB.pid, how: 'ask' }]);
    assert.deepEqual((await new SessionLog(alpha.kit.files, LOG).read()).records, [
      { kind: 'close', session: 'alpha', by: 'idle-pass', at: new Date(alpha.kit.clock.now()).toISOString(), claudeSession: CLAUDE_SESSION, idleMinutes: 75, freedMb: 1300, folder: APP },
    ]);
    assert.deepEqual(actsOf(alpha), [{ v: 1, kind: 'act', mode: 'on', act: 'close', id: 'alpha', outcome: 'done', line, before: CHARGE, after: CHARGE }]);
  });

  it("drops the closed session's restore entry, as teamrig close does (T1425)", async () => {
    const alpha = await runningAlpha(75, reply(40_000), undefined, WAKES_P1);
    const registry = await recordedForRestore(alpha);
    const closed = await idleClose(alpha);
    assert.equal(closed.code, 0, closed.stderr.join('\n'));
    assert.equal(await registry.read(CLAUDE_SESSION), undefined);
    assert.equal((await registry.read(OTHER_SESSION))?.claudeSession, OTHER_SESSION);
  });

  it('tells the lead nothing of a close: no inbox line, no wake ask; the session log holds it (T1890)', async () => {
    const alpha = await runningAlpha();
    const closed = await idleClose(alpha);
    assert.equal(closed.code, 0, closed.stderr.join('\n'));
    assert.match(closed.stdout.join('\n'), /^CLOSED app-alpha \(session alpha\): quiet 75 min, its Claude Code holds 1300 MB, now free$/);
    assert.equal(await alpha.kit.files.read(LEAD_INBOX), undefined);
    assert.deepEqual(await new WakeAsks(alpha.kit.files, ASKS).read('lead'), []);
    assert.deepEqual(
      (await new SessionLog(alpha.kit.files, LOG).read()).records.map((record) => [record.kind, record.session, record.kind === 'close' ? record.by : undefined]),
      [['close', 'alpha', 'idle-pass']],
    );
  });

  it('weighs work as the wake check does: p2 work does not keep it open where only p1 wakes, p1 work does', async () => {
    const alpha = await runningAlpha(75, reply(40_000), undefined, WAKES_P1);
    const added = await alpha.kit.run(['add', '--title', 'Tidy the docs', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
    assert.equal(added.code, 0, added.stderr.join('\n'));
    assertRefused(await close(alpha, ['alpha', '--yes', '--session', 'lead']), /has work it can start \(T1\)/);
    assert.equal((await idleClose(alpha)).code, 0);
    assert.deepEqual(alpha.processes.ends, [{ pid: TAB.pid, how: 'ask' }], 'the pass closes past the wake priority');

    const urgent = await runningAlpha(75, reply(40_000), undefined, WAKES_P1);
    const handed = await urgent.kit.run(['add', '--title', 'Fix the outage', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--session', 'lead']);
    assert.equal(handed.code, 0, handed.stderr.join('\n'));
    const kept = await idleClose(urgent);
    assert.equal(kept.code, 0, kept.stderr.join('\n'));
    assert.match(kept.stdout.join('\n'), /^KEPT app-alpha \(session alpha\) has work it can start \(T1\)/);
    assert.deepEqual(urgent.processes.ends, []);
    assert.equal(urgent.kit.files.get(LOG), undefined);
    assert.deepEqual(actsOf(urgent), [{ v: 1, kind: 'act', mode: 'on', act: 'close', id: 'alpha', outcome: 'kept', line: kept.stdout[0] }]);
    assert.equal(await urgent.kit.files.read(LEAD_INBOX), undefined, 'a session kept open tells the lead nothing');
    assert.deepEqual(await new WakeAsks(urgent.kit.files, ASKS).read('lead'), []);
  });

  it('weighs work as the budget lets the session start it: held, p1 work does not keep it open, p0 work does (T1159)', async () => {
    const config = { ...WAKES_P1, budget: HOLDING_BUDGET };
    const held = await runningAlpha(75, reply(40_000), undefined, config);
    await holdAlpha(held.kit, CLAUDE_SESSION, LEAD_TAB);
    ok(await held.kit.run(['add', '--title', 'Ship the release', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--session', 'lead']));
    const closed = await idleClose(held);
    assert.match(closed.stdout.join('\n'), /^CLOSED app-alpha \(session alpha\): quiet 75 min/, [...closed.stdout, ...closed.stderr].join('\n'));
    assert.deepEqual(held.processes.ends, [{ pid: TAB.pid, how: 'ask' }]);

    const urgent = await runningAlpha(75, reply(40_000), undefined, config);
    await holdAlpha(urgent.kit, CLAUDE_SESSION, LEAD_TAB);
    ok(await urgent.kit.run(['add', '--title', 'Stop the outage', '--description', 'what and why', '--priority', 'p0', '--owner', 'alpha', '--session', 'lead']));
    const kept = await idleClose(urgent);
    assert.match(kept.stdout.join('\n'), /^KEPT app-alpha \(session alpha\) has work it can start \(T1\)/, [...kept.stdout, ...kept.stderr].join('\n'));
    assert.deepEqual(urgent.processes.ends, []);
  });

  it('keeps open a session with an urgent line waiting to wake it, in close and the pass alike', async () => {
    const alpha = await runningAlpha();
    const asks = new WakeAsks(alpha.kit.files, ASKS);
    await asks.post('alpha', { from: 'bravo', text: 'the build broke', at: NOW - MINUTE_MS });
    assertRefused(await close(alpha, ['alpha', '--yes', '--session', 'lead']), /alpha \(session alpha\) has an urgent line from bravo waiting to wake it/);
    await asks.post('alpha', { from: 'lead', text: 'look at it first', at: NOW });
    const kept = await idleClose(alpha);
    assert.equal(kept.code, 0, kept.stderr.join('\n'));
    assert.match(kept.stdout.join('\n'), /^KEPT \S+ \(session alpha\) has 2 urgent lines from bravo, lead waiting to wake it$/);
    assert.deepEqual(alpha.processes.ends, []);

    // A damaged ask wakes no one, so it keeps no one open.
    const damaged = await runningAlpha();
    await damaged.kit.files.write(join(ASKS, 'alpha', `${NOW}-0.json`), '{"v":1,"from":');
    const preview = await close(damaged, ['alpha', '--session', 'lead']);
    assert.match(preview.stdout[0] ?? '', /^CLOSE app-alpha \(session alpha\): quiet 75 min/, [...preview.stdout, ...preview.stderr].join('\n'));
  });

  it("keeps open a session in the owner's started booked meeting however long it is quiet, in close and the pass alike (T2542)", async () => {
    const alpha = await runningAlpha(75, reply(40_000), undefined, WAKES_P1);
    await bookMeeting(alpha, { status: 'started', changedAt: NOW - 60 * MINUTE_MS });
    assertRefused(await close(alpha, ['alpha', '--yes', '--session', 'lead']), /alpha \(session alpha\) is in the owner's open meeting M1: teamrig keeps it open until the meeting ends/);
    const kept = await idleClose(alpha);
    assert.equal(kept.code, 0, kept.stderr.join('\n'));
    assert.match(kept.stdout.join('\n'), /^KEPT app-alpha \(session alpha\) is in the owner's open meeting M1/);
    assert.deepEqual(alpha.processes.ends, []);
    assert.equal(alpha.kit.files.get(LOG), undefined);

    // One it only joins holds it as well.
    const joined = await runningAlpha(75, reply(40_000), undefined, WAKES_P1);
    await bookMeeting(joined, { status: 'started', changedAt: NOW - 60 * MINUTE_MS, session: 'bravo', with: ['alpha'] });
    assert.match((await idleClose(joined)).stdout.join('\n'), /^KEPT app-alpha \(session alpha\) is in the owner's open meeting M1/);
    assert.deepEqual(joined.processes.ends, []);
  });

  it('closes a session whose booked meeting lapsed, ended or has not started (T2542)', async () => {
    for (const meeting of [
      { status: 'started', changedAt: NOW - 5 * 60 * MINUTE_MS },
      { status: 'done', changedAt: NOW - 10 * MINUTE_MS },
      { status: 'scheduled', changedAt: NOW - 60 * MINUTE_MS },
    ] as const) {
      const alpha = await runningAlpha(75, reply(40_000), undefined, WAKES_P1);
      await bookMeeting(alpha, meeting);
      const closed = await idleClose(alpha);
      assert.equal(closed.code, 0, closed.stderr.join('\n'));
      assert.match(closed.stdout.join('\n'), /^CLOSED app-alpha \(session alpha\): quiet 75 min/, meeting.status);
      assert.deepEqual(alpha.processes.ends, [{ pid: TAB.pid, how: 'ask' }], meeting.status);
    }
  });

  it('fails, logged, when it cannot weigh the session or its tab outlives the end', async () => {
    const unlisted = await runningAlpha();
    const blind = await idleClose({ ...unlisted, options: { ...unlisted.options, memory: new FakeHostMemory().lists(undefined) } });
    assert.equal(blind.code, EXIT.failed);
    assert.deepEqual(blind.stdout, ["FAILED to weigh app-alpha (session alpha): teamrig could not list the host's processes, so it cannot tell which sessions run"]);
    assert.deepEqual(actsOf(unlisted), [{ v: 1, kind: 'act', mode: 'on', act: 'close', id: 'alpha', outcome: 'failed', line: blind.stdout[0] }]);

    const stuck = await runningAlpha();
    stuck.processes.failEnd(TAB.pid, 'access denied');
    const failed = await idleClose(stuck);
    assert.equal(failed.code, EXIT.failed);
    assert.deepEqual(failed.stdout, ['FAILED to close app-alpha (session alpha): could not end process 8000: access denied']);
    assert.equal(stuck.kit.files.get(LOG), undefined);
    assert.equal(actsOf(stuck).length, 1);
  });
});
