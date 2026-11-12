import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SessionRecordStore } from '../../sessions/record.ts';
import { FakeHostMemory } from '../../testing/fake-host-memory.ts';
import { FakeSessionProcesses } from '../../testing/fake-session-processes.ts';
import { CliHarness, TEAM, TEAM_HOME } from '../../testing/cli-harness.ts';
import { restartPidOf } from './hook-restart.ts';

const SESSIONS = join(TEAM_HOME, 'state', 'sessions');
const IDS = ['lead', 'alpha', 'bravo'];
const TUI = 6800;
const WORKER = 6900;
const HOST = 6950;
const TRANSCRIPT = '/claude/projects/w/c0.jsonl';
const FORK = `/opt/claude/versions/2.1 --session-id new --fork-session --resume ${TRANSCRIPT}`;
const OTHER_FORK = FORK.replace('c0.jsonl', 'zz.jsonl');
const LIVE = { claudePid: TUI, claudeSession: 'c0', at: '2030-01-08T09:00:00.000Z' };
const ROWS = (parent: number) => [
  { pid: TUI, parent: 1, bytes: 1, startedMs: Date.parse('2030-01-08T08:59:00Z') },
  { pid: WORKER, parent, bytes: 1, startedMs: Date.parse('2030-01-08T09:59:00Z') },
];

/** A tab's Claude Code (6800) beside a hook's (6900, running `commandLine`, started by `parent`); `record` is alpha's session record, if any. */
async function arm(record: object | undefined, commandLine: string, parent = 1): Promise<number | undefined> {
  const kit = new CliHarness(TEAM);
  if (record !== undefined) {
    await new SessionRecordStore(kit.files, { sessions: SESSIONS }).write('alpha', { ...LIVE, ...record });
  }
  const processes = new FakeSessionProcesses(WORKER)
    .add({ pid: TUI, parentPid: 1, name: 'claude.exe', commandLine: 'claude' })
    .add({ pid: WORKER, parentPid: parent, name: 'claude.exe', commandLine });
  const runtime = kit.runtime({ sessionProcesses: processes, memory: new FakeHostMemory().lists(ROWS(parent)) });
  return restartPidOf(runtime, { sessions: SESSIONS }, IDS, 'alpha', WORKER);
}

describe('the pid an automatic restart is armed against', () => {
  it("is the tab's Claude Code, not the forked worker the Stop hook runs in", async () => {
    assert.equal(await arm({}, FORK), TUI);
  });

  it("is the hook's own when it runs inside the tab's process tree", async () => {
    assert.equal(await arm({}, FORK, TUI), WORKER);
  });

  it("is the hook's own when no live record exists", async () => {
    assert.equal(await arm(undefined, FORK), WORKER);
  });

  it("is the hook's own for a fork of another conversation, or a Claude Code that is no fork", async () => {
    assert.equal(await arm({}, OTHER_FORK), WORKER);
    assert.equal(await arm({}, 'claude'), WORKER);
  });

  it("is the hook's own when it is the tab itself", async () => {
    const kit = new CliHarness(TEAM);
    await new SessionRecordStore(kit.files, { sessions: SESSIONS }).write('alpha', LIVE);
    const processes = new FakeSessionProcesses(TUI).add({ pid: TUI, parentPid: 1, name: 'claude.exe', commandLine: 'claude' });
    const runtime = kit.runtime({ sessionProcesses: processes, memory: new FakeHostMemory().lists([ROWS(1)[0]!]) });
    assert.equal(await restartPidOf(runtime, { sessions: SESSIONS }, IDS, 'alpha', TUI), TUI);
  });

  it('is the background job itself when the tab handed its conversation to it: a background session ends no process', async () => {
    const kit = new CliHarness(TEAM);
    await new SessionRecordStore(kit.files, { sessions: SESSIONS }).write('alpha', { ...LIVE, transcript: TRANSCRIPT });
    await kit.files.write(TRANSCRIPT, `${JSON.stringify({ type: 'assistant', entrypoint: 'cli' })}\n${JSON.stringify({ type: 'continued-in', continuedInSessionId: 'job' })}\n`);
    const job = FORK.replace('--session-id new', '--session-id job');
    const processes = new FakeSessionProcesses(WORKER)
      .add({ pid: TUI, parentPid: 1, name: 'claude.exe', commandLine: 'claude' })
      .add({ pid: HOST, parentPid: 1, name: 'claude', commandLine: `claude bg-pty-host --bg-pty-host /tmp/d/pty/job.sock 77 25 -- ${job}` })
      .add({ pid: WORKER, parentPid: HOST, name: 'claude.exe', commandLine: job });
    const runtime = kit.runtime({ sessionProcesses: processes, memory: new FakeHostMemory().lists(ROWS(HOST)) });
    assert.equal(await restartPidOf(runtime, { sessions: SESSIONS }, IDS, 'alpha', WORKER), WORKER);
  });
});
