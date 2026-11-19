import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { CommitCharge } from '../delivery/memory.ts';
import { SessionLog, type CloseRecord } from '../sessions/log.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { WakeAsks } from '../wake/asks.ts';
import { EXIT } from './runtime.ts';

// T4414: right-now work (p0 or above) that a write leaves waiting on another session of the team wakes that session,
// as `inbox add --wake now` would, and reopens it at once when teamrig closed it; else the work sat until its next
// prompt, or for a closed session until the idle pass's next minute.

const LOG = join(TEAM_HOME, 'state', 'session-log.jsonl');
const ASKS = join(TEAM_HOME, 'state', 'wake-asks');
/** Alpha, closed by the idle pass in the project folder. */
const CLOSED: CloseRecord = { kind: 'close', session: 'alpha', by: 'idle-pass', at: '2030-01-08T08:00:00.000Z', claudeSession: CLAUDE_SESSION, idleMinutes: 63, freedMb: 1600, folder: APP };
const ROOM: CommitCharge = { usedMb: 40_000, limitMb: 100_700 };

interface Run {
  readonly result: CliResult;
  readonly processes: FakeProcesses;
}

async function run(kit: CliHarness, argv: readonly string[]): Promise<Run> {
  const processes = new FakeProcesses();
  const options: RunOptions = { processes, memory: new FakeHostMemory().lists([], ROOM), probe: new FakePathProbe({ folders: [APP] }) };
  const result = await kit.run(argv, options);
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
  return { result, processes };
}

/** The idle-pass reopens the run started, as `[session, team, project]`. */
function reopensStarted(processes: FakeProcesses): string[][] {
  return processes.hidden.filter((start) => start.args[1] === 'idle-open').map((start) => [start.args[2] ?? '', start.args[4] ?? '', start.args[6] ?? '']);
}

async function asksOf(kit: CliHarness, session: string): Promise<number> {
  return (await new WakeAsks(kit.files, ASKS).read(session)).length;
}

async function inboxOf(kit: CliHarness, session: string): Promise<string> {
  return (await kit.run(['inbox', 'read', '--session', session])).stdout.join('\n');
}

/** A team with alpha's T1, a p2 not due, and alpha closed by teamrig unless `closed` is false. */
async function teamWithAlphaTask(closed = true): Promise<CliHarness> {
  const kit = new CliHarness(TEAM);
  if (closed) {
    await new SessionLog(kit.files, LOG).append(CLOSED);
  }
  await run(kit, ['add', '--title', 'Cut the schema', '--description', 'what and why', '--priority', 'p2', '--owner', 'alpha', '--session', 'lead']);
  assert.equal(await asksOf(kit, 'alpha'), 0, 'a p2 with no due day wakes nobody');
  return kit;
}

const after = (priority: string, by = 'lead'): readonly string[] => ['add', '--title', 'Fix the outage', '--description', 'what and why', '--priority', priority, '--owner', 'bravo', '--after', 'T1', '--session', by];

describe('right-now work waiting on a session wakes it (T4414)', () => {
  it('a p0 added after a closed session\'s task tells it, posts a wake ask, and starts its reopen at once', async () => {
    const kit = await teamWithAlphaTask();
    const { result, processes } = await run(kit, after('p0'));
    assert.match(result.stderr.join('\n'), /^NOTE alpha gets a wake ask: T2 is a p0 waiting on it$/m);
    assert.deepEqual(reopensStarted(processes), [['alpha', 'app', APP]]);
    assert.equal(await asksOf(kit, 'alpha'), 1);
    assert.match(await inboxOf(kit, 'alpha'), /lead: T2 \(p0, owner bravo\) waits on your T1$/m);
  });

  it('a p0 set waiting on work asked of a peer posts that peer a wake ask', async () => {
    const kit = new CliHarness(TEAM);
    await run(kit, ['add', '--title', 'Ship the fix', '--description', 'what and why', '--priority', 'p0', '--session', 'bravo']);
    // Only a started task may wait.
    await run(kit, ['set', 'T1', '--status', 'in-progress', '--session', 'bravo']);
    const { result } = await run(kit, ['set', 'T1', '--status', 'waiting', '--ask', 'alpha', '--text', 'review branch t1', '--session', 'bravo']);
    assert.match(result.stderr.join('\n'), /^NOTE alpha gets a wake ask: T1 is a p0 waiting on it$/m);
    assert.equal(await asksOf(kit, 'alpha'), 1);
  });

  it('a p2 added after the task wakes nobody and starts nothing', async () => {
    const kit = await teamWithAlphaTask();
    const { result, processes } = await run(kit, after('p2'));
    assert.doesNotMatch(result.stderr.join('\n'), /gets a wake ask/);
    assert.deepEqual([reopensStarted(processes), await asksOf(kit, 'alpha')], [[], 0]);
  });

  it('raising a waiting task to p0 wakes the session; a later write that changes no wait asks no more', async () => {
    const kit = await teamWithAlphaTask();
    await run(kit, after('p2'));
    const raised = await run(kit, ['update', 'T2', '--priority', 'p0', '--session', 'lead']);
    assert.deepEqual(reopensStarted(raised.processes), [['alpha', 'app', APP]]);
    assert.equal(await asksOf(kit, 'alpha'), 1);
    const again = await run(kit, ['update', 'T2', '--due', '2030-01-20', '--session', 'lead']);
    assert.doesNotMatch(again.result.stderr.join('\n'), /gets a wake ask/);
    assert.equal(await asksOf(kit, 'alpha'), 1, 'the wait was already told');
  });

  it('never asks the writer to wake for its own write', async () => {
    const kit = await teamWithAlphaTask(false);
    const { result } = await run(kit, after('p0', 'alpha'));
    assert.doesNotMatch(result.stderr.join('\n'), /alpha gets a wake ask/);
    assert.equal(await asksOf(kit, 'alpha'), 0);
  });
});
