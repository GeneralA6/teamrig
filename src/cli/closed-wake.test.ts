import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { CommitCharge } from '../delivery/memory.ts';
import { SessionLog, type CloseRecord } from '../sessions/log.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { WakeAsks } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

// #1581: a wake for a session teamrig closed never prints WAKES; its reopen starts at once
// through the idle pass's own act when the host has room, else the sender is told CLOSED and why.

const LOG = join(TEAM_HOME, 'state', 'session-log.jsonl');
const ASKS = join(TEAM_HOME, 'state', 'wake-asks');
/** Alpha, closed by the idle pass in the project folder. */
const CLOSED: CloseRecord = { kind: 'close', session: 'alpha', by: 'idle-pass', at: '2030-01-08T08:00:00.000Z', claudeSession: CLAUDE_SESSION, idleMinutes: 63, freedMb: 1600, folder: APP };
const ROOM: CommitCharge = { usedMb: 40_000, limitMb: 100_700 };
const FULL: CommitCharge = { usedMb: 99_000, limitMb: 100_000 };

interface Run {
  readonly result: CliResult;
  readonly processes: FakeProcesses;
}

async function teamWithClosedAlpha(closed = true): Promise<CliHarness> {
  const kit = new CliHarness(TEAM);
  if (closed) {
    await new SessionLog(kit.files, LOG).append(CLOSED);
  }
  return kit;
}

async function run(kit: CliHarness, argv: readonly string[], charge: CommitCharge = ROOM, processes = new FakeProcesses()): Promise<Run> {
  const options: RunOptions = { processes, memory: new FakeHostMemory().lists([], charge), probe: new FakePathProbe({ folders: [APP] }) };
  return { result: await kit.run(argv, options), processes };
}

/** The idle-pass reopens the run started, as `[session, team, project]`. */
function reopensStarted(processes: FakeProcesses): string[][] {
  return processes.hidden.filter((start) => start.args[1] === 'idle-open').map((start) => [start.args[2] ?? '', start.args[4] ?? '', start.args[6] ?? '']);
}

async function asksOf(kit: CliHarness): Promise<number> {
  return (await new WakeAsks(kit.files, ASKS).read('alpha')).length;
}

const WAKE_NOW = ['inbox', 'add', '--session', 'lead', '--to', 'alpha', '--text', 'Re-confirm #169 now.', '--wake', 'now'];

describe('inbox add --wake now to a session teamrig closed (#1581)', () => {
  it('closed, the host with room: posts the ask, starts its reopen at once, and says REOPENS, never WAKES', async () => {
    const kit = await teamWithClosedAlpha();
    const { result, processes } = await run(kit, WAKE_NOW);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    const out = result.stdout.join('\n');
    assert.match(out, /^REOPENS alpha: it was closed, and its reopen started now for this line;/m);
    assert.doesNotMatch(out, /WAKES/);
    assert.deepEqual(reopensStarted(processes), [['alpha', 'app', APP]]);
    assert.equal(await asksOf(kit), 1, 'the ask the reopen quotes in its first prompt');
  });

  it('closed, no room on the host: says CLOSED and why, starts nothing, and keeps the ask for the next pass', async () => {
    const kit = await teamWithClosedAlpha();
    const { result, processes } = await run(kit, WAKE_NOW, FULL);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    const out = result.stdout.join('\n');
    assert.match(out, /^CLOSED: alpha was not woken: no room on the host to reopen app-alpha.*; the idle pass tries again each minute, or run: teamrig open alpha$/m);
    assert.doesNotMatch(out, /WAKES|REOPENS/);
    assert.deepEqual(reopensStarted(processes), []);
    assert.equal(await asksOf(kit), 1);
  });

  it('open and idle (never closed, or reopened since): WAKES as before, nothing started', async () => {
    for (const reopened of [false, true]) {
      const kit = await teamWithClosedAlpha(reopened);
      if (reopened) {
        await new SessionLog(kit.files, LOG).append({ kind: 'reopen', session: 'alpha', at: '2030-01-08T09:00:00.000Z' });
      }
      const { result, processes } = await run(kit, WAKE_NOW);
      assert.match(result.stdout.join('\n'), /^WAKES alpha if its tab is idle/m, `reopened: ${reopened}`);
      assert.deepEqual(reopensStarted(processes), []);
    }
  });

  it('a tab started by hand since the close (busy or not) counts as open: WAKES as before, nothing started', async () => {
    const kit = await teamWithClosedAlpha();
    await new SessionRecordStore(kit.files, { sessions: join(TEAM_HOME, 'state', 'sessions') }).write('alpha', { claudeSession: CLAUDE_SESSION, claudePid: 4100, at: '2030-01-08T08:30:00.000Z' });
    const { result, processes } = await run(kit, WAKE_NOW);
    assert.match(result.stdout.join('\n'), /^WAKES alpha if its tab is idle/m);
    assert.deepEqual(reopensStarted(processes), []);
  });

  it('--wake-by to a closed session: the line waits for its time, said as CLOSED, nothing started now', async () => {
    const kit = await teamWithClosedAlpha();
    const { result, processes } = await run(kit, ['inbox', 'add', '--session', 'lead', '--to', 'alpha', '--text', 'Later.', '--wake-by', '2030-01-09 09:00']);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.match(result.stdout.join('\n'), /^CLOSED: alpha is closed, so this line waits: the idle pass reopens it for the line once it is due/m);
    assert.doesNotMatch(result.stdout.join('\n'), /WAKES/);
    assert.deepEqual(reopensStarted(processes), []);
  });

  it('with the idle pass off, a closed session is CLOSED: nothing reopens it but teamrig open', async () => {
    const kit = new CliHarness({ ...TEAM, open: { idle: { mode: 'off' } } });
    await new SessionLog(kit.files, LOG).append(CLOSED);
    const { result, processes } = await run(kit, WAKE_NOW);
    assert.match(result.stdout.join('\n'), /^CLOSED: alpha was not woken: open\.idle\.mode is off, so the idle pass reopens nothing; .* teamrig open alpha$/m);
    assert.deepEqual(reopensStarted(processes), []);
  });
});

describe('a closed session whose reopen cannot start (#1581)', () => {
  it('says CLOSED with why when node is missing or the start fails, and keeps the ask for the next pass', async () => {
    const probe = await run(await teamWithClosedAlpha(), WAKE_NOW);
    const node = probe.processes.hidden[0]?.command ?? '';
    const outcomes = [
      [{ kind: 'missing' }, /its reopen did not start \(node was not found\)/],
      [{ kind: 'failed', error: 'spawn EACCES' }, /its reopen did not start \(spawn EACCES\)/],
    ] as const;
    for (const [outcome, why] of outcomes) {
      const kit = await teamWithClosedAlpha();
      const { result } = await run(kit, WAKE_NOW, ROOM, new FakeProcesses().onStart(node, outcome));
      const out = result.stdout.join('\n');
      assert.match(out, /^CLOSED: alpha was not woken: /m, outcome.kind);
      assert.match(out, why, outcome.kind);
      assert.doesNotMatch(out, /WAKES|REOPENS/, outcome.kind);
      assert.equal(await asksOf(kit), 1, outcome.kind);
    }
  });

  it('says CLOSED when its close names no folder, starting nothing', async () => {
    const kit = new CliHarness(TEAM);
    const { folder: _folder, ...noFolder } = CLOSED;
    await new SessionLog(kit.files, LOG).append(noFolder);
    const { result, processes } = await run(kit, WAKE_NOW);
    assert.match(result.stdout.join('\n'), /^CLOSED: alpha was not woken: its close names no folder to reopen it in;/m);
    assert.deepEqual(reopensStarted(processes), []);
  });
});

describe('a task due today handed to a session teamrig closed (#1581)', () => {
  const add = (due: string): readonly string[] => ['add', '--title', 'Re-confirm #169', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--due', due, '--session', 'lead'];

  it('posts a wake ask and starts its reopen at once, though p2 is past wake.priority', async () => {
    const kit = await teamWithClosedAlpha();
    const today = new Date(kit.clock.now()).toISOString().slice(0, 10);
    const { result, processes } = await run(kit, add(today));
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.match(result.stderr.join('\n'), /^REOPENS alpha: it was closed, and its reopen started now for this line;.* \(T1 is due today\)$/m);
    assert.deepEqual(reopensStarted(processes), [['alpha', 'app', APP]]);
    assert.equal(await asksOf(kit), 1);
  });

  it('a task due a later day, or one for an open session, posts no ask and starts nothing', async () => {
    const later = await teamWithClosedAlpha();
    const tomorrow = new Date(later.clock.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const notToday = await run(later, add(tomorrow));
    assert.deepEqual([reopensStarted(notToday.processes), await asksOf(later)], [[], 0]);
    const open = await teamWithClosedAlpha(false);
    const today = new Date(open.clock.now()).toISOString().slice(0, 10);
    const notClosed = await run(open, add(today));
    assert.deepEqual([reopensStarted(notClosed.processes), await asksOf(open)], [[], 0]);
    assert.doesNotMatch(notClosed.result.stderr.join('\n'), /REOPENS|CLOSED/);
  });
});
