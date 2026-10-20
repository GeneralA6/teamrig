import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeTreeKill, parseStartedProcesses, stragglersOf, sweepTree, SWEEP_ROUNDS, type StartedProcess, type SweepHost } from './tree-kill.ts';

/** A host whose process lists are set by the test, one a call; it records each kill and keeps one clock. */
class FakeHost implements SweepHost {
  readonly kills: (readonly number[])[] = [];
  listCalls = 0;
  private readonly lists: (readonly StartedProcess[] | undefined)[];

  constructor(lists: (readonly StartedProcess[] | undefined)[]) {
    this.lists = lists;
  }

  list(): Promise<readonly StartedProcess[] | undefined> {
    this.listCalls += 1;
    return Promise.resolve(this.lists.shift());
  }

  kill(pids: readonly number[]): Promise<void> {
    this.kills.push(pids);
    return Promise.resolve();
  }

  now(): number {
    return 1_000;
  }
}

const proc = (pid: number, parent: number, startedMs: number): StartedProcess => ({ pid, parent, startedMs });

/** The step's shell 10 started 11; 20 runs beside it. */
const STEP = [proc(1, 0, 0), proc(10, 1, 100), proc(11, 10, 200), proc(20, 1, 50)];

describe('sweepTree', () => {
  it('kills the tree once when the next list finds nothing of it', async () => {
    const host = new FakeHost([STEP, [proc(1, 0, 0), proc(20, 1, 50)]]);
    await sweepTree(10, host);
    assert.deepEqual(host.kills, [[10, 11]]);
    assert.equal(host.listCalls, 2);
  });

  it('kills a process the tree started while it was killed, with what that one started', async () => {
    const orphans = [proc(1, 0, 0), proc(20, 1, 50), proc(12, 11, 900), proc(13, 12, 950)];
    const host = new FakeHost([STEP, orphans, [proc(1, 0, 0), proc(20, 1, 50)]]);
    await sweepTree(10, host);
    assert.deepEqual(host.kills, [[10, 11], [12, 13]]);
  });

  it('kills again a member that outlived its kill', async () => {
    const host = new FakeHost([STEP, [proc(20, 1, 50), proc(11, 10, 200)], []]);
    await sweepTree(10, host);
    assert.deepEqual(host.kills, [[10, 11], [11]]);
  });

  it('falls back to one kill of the root when the host cannot be listed', async () => {
    const host = new FakeHost([undefined]);
    await sweepTree(10, host);
    assert.deepEqual(host.kills, [[10]]);
  });

  it('stops when the list after a kill fails', async () => {
    const host = new FakeHost([STEP, undefined]);
    await sweepTree(10, host);
    assert.deepEqual(host.kills, [[10, 11]]);
  });

  it('kills nothing when the root is no longer listed', async () => {
    const host = new FakeHost([[proc(1, 0, 0)]]);
    await sweepTree(10, host);
    assert.deepEqual(host.kills, []);
  });

  it('gives up after its rounds when every list shows a new straggler', async () => {
    const lists = [STEP, ...Array.from({ length: SWEEP_ROUNDS }, (_, round) => [proc(30 + round, round === 0 ? 11 : 29 + round, 500)])];
    const host = new FakeHost(lists);
    await sweepTree(10, host);
    assert.equal(host.kills.length, SWEEP_ROUNDS);
    assert.deepEqual(host.kills.at(-1), [30 + SWEEP_ROUNDS - 2]);
  });
});

describe('stragglersOf', () => {
  const members = new Map([
    [10, 100],
    [11, 200],
  ]);

  it('leaves alone a stranger that took a member’s id, and what it started', () => {
    const rows = [proc(11, 1, 950), proc(40, 11, 960)];
    assert.deepEqual(stragglersOf(rows, members, 1_000), []);
  });

  it('leaves alone a process started after the kill ended, under a member’s freed id', () => {
    assert.deepEqual(stragglersOf([proc(41, 10, 1_001)], members, 1_000), []);
  });

  it('leaves alone a process beside the tree', () => {
    assert.deepEqual(stragglersOf([proc(20, 1, 50)], members, 1_000), []);
  });

  it('lists an orphan of a member once, with its tree, even when its child is a seed too', () => {
    const rows = [proc(12, 11, 900), proc(13, 12, 950), proc(14, 10, 990)];
    assert.deepEqual(
      stragglersOf(rows, members, 1_000).map((row) => row.pid),
      [12, 13, 14],
    );
  });
});

describe('parseStartedProcesses', () => {
  it('reads the PowerShell lines, leaving out damaged ones', () => {
    assert.deepEqual(parseStartedProcesses('0,0,0\r\n4880,4,1791979177632\nProcessId\n'), [proc(0, 0, 0), proc(4880, 4, 1791979177632)]);
  });
});

describe('nodeTreeKill', () => {
  it('sweeps through the host it is given on Windows', async () => {
    const host = new FakeHost([STEP, []]);
    await nodeTreeKill('win32', host)(10);
    assert.deepEqual(host.kills, [[10, 11]]);
  });

  it('settles at once on POSIX when the group has already ended', async () => {
    const host = new FakeHost([]);
    await nodeTreeKill('linux', host)(2 ** 22 + 7);
    assert.equal(host.listCalls, 0);
  });
});
