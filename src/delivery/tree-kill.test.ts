import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { treeOf } from './processes.ts';
import { nodeTreeKill, parseStartedProcesses, stragglersOf, sweepTree, SWEEP_ROUNDS, windowsSweepHostOf, type HostRun, type StartedProcess, type SweepHost } from './tree-kill.ts';

/** A host whose process lists are set by the test, one a call; it records each kill and keeps one clock. */
class FakeHost implements SweepHost {
  readonly kills: (readonly number[])[] = [];
  readonly treeKills: number[] = [];
  listCalls = 0;
  private readonly lists: (readonly StartedProcess[] | undefined)[];

  constructor(lists: (readonly StartedProcess[] | undefined)[]) {
    this.lists = lists;
  }

  list(): Promise<readonly StartedProcess[] | undefined> {
    this.listCalls += 1;
    return Promise.resolve(this.lists.shift());
  }

  kill(targets: readonly StartedProcess[]): Promise<void> {
    this.kills.push(targets.map((target) => target.pid));
    return Promise.resolve();
  }

  killTree(root: number): Promise<void> {
    this.treeKills.push(root);
    return Promise.resolve();
  }

  now(): number {
    return 1_000;
  }
}

const proc = (pid: number, parent: number, startedMs: number): StartedProcess => ({ pid, parent, startedMs });

/** The `<id> = <start>` pairs of a kill script's `$want` table. */
function killTargets(script: string): StartedProcess[] {
  const table = /\$want = @\{([^}]*)\}/.exec(script)?.[1] ?? '';
  return [...table.matchAll(/(\d+) = (\d+)/g)].map((pair) => proc(Number(pair[1]), 0, Number(pair[2])));
}

/**
 * A process table behind fake `powershell.exe` and `taskkill` runs. A run reads the table first, then the processes
 * born during it join: a list misses them, and so does a kill. A born process whose id a listed one holds replaces it:
 * that one ended, and Windows gave its id to the newcomer. A kill script ends each process it names whose start is the
 * named one; taskkill ends the processes it names by id alone and, with /T, the rest of their trees as its walk found
 * them.
 */
class ProcessTable {
  readonly runs: (readonly string[])[] = [];
  /** The ids each kill script named, in order. */
  readonly kills: (readonly number[])[] = [];
  private rows: StartedProcess[];
  private readonly births: ReadonlyMap<number, readonly StartedProcess[]>;

  /** `births` maps a run's index (0 for the first run) to the processes born while it runs. */
  constructor(rows: readonly StartedProcess[], births: ReadonlyMap<number, readonly StartedProcess[]>) {
    this.rows = [...rows];
    this.births = births;
  }

  readonly run: HostRun = (file, args) => {
    const born = this.births.get(this.runs.length) ?? [];
    this.runs.push([file, ...args]);
    if (file === 'taskkill') {
      const ended = this.walk(args);
      this.rows = this.rows.filter((row) => !ended.has(row.pid));
      this.join(born);
      return Promise.resolve('');
    }
    const script = args.at(-1) ?? '';
    if (script.includes('.Kill()')) {
      const targets = killTargets(script);
      this.kills.push(targets.map((target) => target.pid));
      this.rows = this.rows.filter((row) => !targets.some((target) => target.pid === row.pid && target.startedMs === row.startedMs));
      this.join(born);
      return Promise.resolve('');
    }
    const printed = this.rows.map((row) => `${row.pid},${row.parent},${row.startedMs}`).join('\r\n');
    this.join(born);
    return Promise.resolve(printed);
  };

  now(): readonly StartedProcess[] {
    return this.rows;
  }

  pids(): number[] {
    return this.rows.map((row) => row.pid);
  }

  private join(born: readonly StartedProcess[]): void {
    this.rows = [...this.rows.filter((row) => !born.some((newcomer) => newcomer.pid === row.pid)), ...born];
  }

  /** The ids a taskkill run ends: those it names, and with /T their trees as they stand now. */
  private walk(args: readonly string[]): Set<number> {
    const named = args.flatMap((arg, index) => (args[index - 1] === '/PID' ? [Number(arg)] : []));
    return new Set(args.includes('/T') ? named.flatMap((pid) => treeOf(pid, this.rows).map((row) => row.pid)) : named);
  }
}

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

  it('falls back to one tree kill of the root when the host cannot be listed', async () => {
    const host = new FakeHost([undefined]);
    await sweepTree(10, host);
    assert.deepEqual(host.kills, []);
    assert.deepEqual(host.treeKills, [10]);
  });

  it('stops when the list after a kill fails, killing no old id again', async () => {
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

describe('sweepTree on the Windows host', () => {
  it('ends a command born after the list and the grandchild it starts while the kill runs (T990)', async () => {
    // The list sees the shell 10 alone; its command 12 starts during that list, and starts 13 during the first kill.
    const table = new ProcessTable(
      [proc(1, 0, 0), proc(10, 1, 100)],
      new Map([
        [0, [proc(12, 10, 900)]],
        [1, [proc(13, 12, 950)]],
      ]),
    );
    await sweepTree(10, windowsSweepHostOf(table.run, () => 1_000));
    assert.deepEqual(table.pids(), [1]);
    assert.deepEqual(table.kills, [[10], [12, 13]]);
  });

  it('leaves alone a stranger that took the id of a member ended during the list (T1562)', async () => {
    // The list sees shell 10 and its console 11; 11 ends by itself while the list runs, and Windows hands its id to
    // stranger 11, born under process 1 just before the kill.
    const table = new ProcessTable([proc(1, 0, 0), proc(10, 1, 100), proc(11, 10, 150)], new Map([[0, [proc(11, 1, 960)]]]));
    await sweepTree(10, windowsSweepHostOf(table.run, () => 1_000));
    assert.deepEqual(table.now(), [proc(1, 0, 0), proc(11, 1, 960)]);
  });

  it('leaves a process beside the tree running', async () => {
    const table = new ProcessTable(STEP, new Map());
    await sweepTree(10, windowsSweepHostOf(table.run, () => 1_000));
    assert.deepEqual(table.pids(), [1, 20]);
  });
});

describe('windowsSweepHostOf', () => {
  /** A run that records each call; taskkill and a kill script print nothing, and a list fails. */
  function recorder(): { runs: (readonly string[])[]; run: HostRun } {
    const runs: (readonly string[])[] = [];
    return {
      runs,
      run: (file, args) => {
        runs.push([file, ...args]);
        return Promise.resolve(file === 'taskkill' || (args.at(-1) ?? '').includes('.Kill()') ? '' : undefined);
      },
    };
  }

  it('ends exactly the processes it is given, each by id and start in one PowerShell run, without taskkill', async () => {
    const { runs, run } = recorder();
    await windowsSweepHostOf(run).kill([proc(10, 1, 100), proc(11, 10, 200)]);
    assert.equal(runs.length, 1);
    const [file, ...args] = runs[0] ?? [];
    assert.equal(file, 'powershell.exe');
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    const script = args[3] ?? '';
    assert.match(script, /\$want = @\{ 10 = 100; 11 = 200 \}/);
    assert.ok(script.indexOf('.Handle') < script.indexOf('Get-CimInstance'), 'it holds each id before it reads the starts');
    assert.match(script, /\.Kill\(\)/);
    assert.doesNotMatch(script, /taskkill/);
  });

  it('runs nothing for no targets', async () => {
    const { runs, run } = recorder();
    await windowsSweepHostOf(run).kill([]);
    assert.deepEqual(runs, []);
  });

  it('ends a whole tree with /T only for the fallback', async () => {
    const { runs, run } = recorder();
    await windowsSweepHostOf(run).killTree(10);
    assert.deepEqual(runs, [['taskkill', '/F', '/T', '/PID', '10']]);
  });

  it('lists nothing when PowerShell fails', async () => {
    const { run } = recorder();
    assert.equal(await windowsSweepHostOf(run).list(), undefined);
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
