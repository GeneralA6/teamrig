import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  nodeMemoryProbe,
  parseMeminfoCommit,
  parseProcessRows,
  parseWindowsCommit,
  treeCommittedMb,
  treeMb,
  watchMemory,
  type CommitCharge,
  type Every,
  type MemoryProbe,
  type ProcessRow,
} from './memory.ts';
import { treeOf } from './processes.ts';

const MB = 2 ** 20;

/** A host of processes: 1 starts 10, 10 starts 11 and 12, 12 starts 13; 20 is apart. */
const ROWS: readonly ProcessRow[] = [
  { pid: 1, parent: 0, bytes: 5 * MB },
  { pid: 10, parent: 1, bytes: 100 * MB },
  { pid: 11, parent: 10, bytes: 200 * MB },
  { pid: 12, parent: 10, bytes: 300 * MB },
  { pid: 13, parent: 12, bytes: 400 * MB },
  { pid: 20, parent: 1, bytes: 900 * MB },
];

/** A probe whose free memory and process lists are set by the test, one list a sample. */
class FakeProbe implements MemoryProbe {
  free = 8000;
  readonly lists: (readonly ProcessRow[] | undefined)[] = [];
  listed = 0;
  private release: (() => void) | undefined;
  private held = false;

  freeMb(): number {
    return this.free;
  }

  totalMb(): number {
    return 32768;
  }

  async commit(): Promise<CommitCharge | undefined> {
    return undefined;
  }

  /** The next process list waits until `finish` is called, as a slow PowerShell does. */
  holdNext(): void {
    this.held = true;
  }

  finish(): void {
    this.release?.();
  }

  async processes(): Promise<readonly ProcessRow[] | undefined> {
    this.listed += 1;
    if (this.held) {
      this.held = false;
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return this.lists.shift();
  }
}

/** A timer the test ticks by hand. */
class FakeTimer {
  tick: (() => void) | undefined;
  intervalMs: number | undefined;
  cancelled = false;

  readonly every: Every = (ms, tick) => {
    this.intervalMs = ms;
    this.tick = tick;
    return () => {
      this.cancelled = true;
    };
  };
}

describe('treeMb', () => {
  it('sums a process and every descendant, leaving out processes beside it', () => {
    assert.equal(treeMb(10, ROWS), 1000);
  });

  it('is 0 for a process that is not listed', () => {
    assert.equal(treeMb(99, ROWS), 0);
  });

  it('stops at a parent loop or a process that names itself as its parent', () => {
    const looped: ProcessRow[] = [
      { pid: 5, parent: 5, bytes: MB },
      { pid: 6, parent: 7, bytes: MB },
      { pid: 7, parent: 6, bytes: MB },
    ];
    assert.equal(treeMb(5, looped), 1);
    assert.equal(treeMb(6, looped), 2);
  });

  it('leave out a process listed as started before its parent: its own parent ended and the id was reused', () => {
    const reused: ProcessRow[] = [
      { pid: 30, parent: 1, bytes: 100 * MB, startedMs: 5_000 },
      { pid: 31, parent: 30, bytes: 200 * MB, startedMs: 6_000 },
      { pid: 32, parent: 30, bytes: 400 * MB, startedMs: 4_000 },
      { pid: 33, parent: 32, bytes: 800 * MB, startedMs: 7_000 },
      { pid: 34, parent: 30, bytes: 50 * MB },
    ];
    assert.deepEqual(
      treeOf(30, reused).map((row) => row.pid),
      [30, 31, 34],
      'a child with no start counts, as in a ps list',
    );
    assert.equal(treeMb(30, reused), 350);
  });
});

describe('parseProcessRows', () => {
  it('reads PowerShell commas and ps columns, leaving out headers and damaged lines', () => {
    assert.deepEqual(parseProcessRows('4,0,1024\r\n  77   4  2048\nProcessId,ParentProcessId\n9,x,1\n\n'), [
      { pid: 4, parent: 0, bytes: 1024 },
      { pid: 77, parent: 4, bytes: 2048 },
    ]);
  });

  it('reads a fourth number as when the process started, a fifth as what it committed, and leaves out a line of six', () => {
    assert.deepEqual(parseProcessRows('4,0,1024,0\r\n77,4,2048,1760000000000\n78,4,2048,1760000000000,4096\n8,4,1,2,3,5\n'), [
      { pid: 4, parent: 0, bytes: 1024, startedMs: 0 },
      { pid: 77, parent: 4, bytes: 2048, startedMs: 1_760_000_000_000 },
      { pid: 78, parent: 4, bytes: 2048, startedMs: 1_760_000_000_000, committed: 4096 },
    ]);
  });
});

describe('treeCommittedMb', () => {
  it('sums what a process and every descendant committed, leaving out processes beside it', () => {
    const rows: ProcessRow[] = [
      { pid: 10, parent: 1, bytes: MB, committed: 900 * MB },
      { pid: 11, parent: 10, bytes: MB, committed: 200 * MB },
      { pid: 20, parent: 1, bytes: MB, committed: 5000 * MB },
    ];
    assert.equal(treeCommittedMb(10, rows), 1100);
  });

  it('is undefined when a process of the tree is listed without it, as a ps list gives', () => {
    assert.equal(treeCommittedMb(10, ROWS), undefined);
  });
});

describe('parseWindowsCommit and parseMeminfoCommit', () => {
  it('read the commit limit and what is used of it, in MB', () => {
    assert.deepEqual(parseWindowsCommit('103116800,15769600\r\n'), { usedMb: 85_300, limitMb: 100_700 });
    const meminfo = 'MemTotal:       16384000 kB\nCommitLimit:    20480000 kB\nCommitted_AS:   25600000 kB\n';
    assert.deepEqual(parseMeminfoCommit(meminfo), { usedMb: 25_000, limitMb: 20_000 }, 'Linux may commit past its limit');
  });

  it('read nothing from damaged output', () => {
    for (const text of ['', '100', '100,x', '100,200', '0,0', '1,2,3']) {
      assert.equal(parseWindowsCommit(text), undefined, text);
    }
    assert.equal(parseMeminfoCommit('MemTotal: 16384000 kB\nCommitLimit: 20480000 kB\n'), undefined);
    assert.equal(parseMeminfoCommit('CommitLimit: 0 kB\nCommitted_AS: 100 kB\n'), undefined);
  });
});

describe('watchMemory', () => {
  it('samples at once and on each tick, keeping the largest tree and the least free memory', async () => {
    const probe = new FakeProbe();
    const timer = new FakeTimer();
    probe.lists.push(ROWS, [...ROWS.filter((row) => row.pid !== 13), { pid: 14, parent: 11, bytes: 2000 * MB }]);
    const watch = watchMemory(probe, 10, 15_000, timer.every);
    assert.equal(timer.intervalMs, 15_000);
    await new Promise((resolve) => setImmediate(resolve));
    probe.free = 6500;
    timer.tick?.();
    await new Promise((resolve) => setImmediate(resolve));
    probe.free = 7000;
    assert.deepEqual(await watch.stop(), { peakTreeMb: 2600, lowFreeMb: 6500, startFreeMb: 8000 });
    assert.equal(timer.cancelled, true);
  });

  it('skips a tick while a sample still runs, and stop waits for that sample', async () => {
    const probe = new FakeProbe();
    const timer = new FakeTimer();
    probe.lists.push(ROWS);
    probe.holdNext();
    const watch = watchMemory(probe, 10, 15_000, timer.every);
    timer.tick?.();
    timer.tick?.();
    assert.equal(probe.listed, 1, 'no second list while the first runs');
    const stopped = watch.stop();
    probe.finish();
    assert.deepEqual(await stopped, { peakTreeMb: 1000, lowFreeMb: 8000, startFreeMb: 8000 });
  });

  it('measures free memory alone when no process list could be read', async () => {
    const probe = new FakeProbe();
    const watch = watchMemory(probe, 10, 15_000, new FakeTimer().every);
    probe.free = 3000;
    assert.deepEqual(await watch.stop(), { lowFreeMb: 3000, startFreeMb: 8000 }, 'the first read is the start, before the host lost memory');
  });
});

describe('nodeMemoryProbe', () => {
  it('lists this process and leaves out the lister it started', async () => {
    const probe = nodeMemoryProbe(process.platform);
    assert.ok(probe.freeMb() > 0);
    const rows = await probe.processes();
    assert.ok(rows !== undefined, 'the host lists its processes');
    assert.ok(treeMb(process.pid, rows) > 0, 'this process is listed with its memory');
    const committed = treeCommittedMb(process.pid, rows);
    if (process.platform === 'win32') {
      assert.ok(committed !== undefined && committed > 0, 'Windows lists what this process committed');
    } else {
      assert.equal(committed, undefined, 'ps lists no commit');
    }
    assert.deepEqual(
      treeOf(process.pid, rows).filter((row) => row.pid !== process.pid),
      [],
      'this process has no child left in its list: the lister is left out',
    );
  });

  it("reads the host's RAM, never less than its free memory", () => {
    const probe = nodeMemoryProbe(process.platform);
    assert.ok(probe.totalMb() >= probe.freeMb() && probe.totalMb() > 0, `${probe.freeMb()} of ${probe.totalMb()} MB free`);
  });

  it('reads the commit charge on Windows and Linux, and nothing elsewhere', async () => {
    const charge = await nodeMemoryProbe(process.platform).commit();
    if (process.platform !== 'win32' && process.platform !== 'linux') {
      assert.equal(charge, undefined);
      return;
    }
    assert.ok(charge !== undefined, 'the host gives its commit charge');
    assert.ok(charge.usedMb > 0 && charge.limitMb > 0, `${charge.usedMb} of ${charge.limitMb} MB`);
  });
});
