import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeMemoryProbe, parseProcessRows, treeMb, watchMemory, type Every, type MemoryProbe, type ProcessRow } from './memory.ts';
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
});

describe('parseProcessRows', () => {
  it('reads PowerShell commas and ps columns, leaving out headers and damaged lines', () => {
    assert.deepEqual(parseProcessRows('4,0,1024\r\n  77   4  2048\nProcessId,ParentProcessId\n9,x,1\n\n'), [
      { pid: 4, parent: 0, bytes: 1024 },
      { pid: 77, parent: 4, bytes: 2048 },
    ]);
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
    assert.deepEqual(await watch.stop(), { peakTreeMb: 2600, lowFreeMb: 6500 });
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
    assert.deepEqual(await stopped, { peakTreeMb: 1000, lowFreeMb: 8000 });
  });

  it('measures free memory alone when no process list could be read', async () => {
    const probe = new FakeProbe();
    const watch = watchMemory(probe, 10, 15_000, new FakeTimer().every);
    probe.free = 3000;
    assert.deepEqual(await watch.stop(), { lowFreeMb: 3000 });
  });
});

describe('nodeMemoryProbe', () => {
  it('lists this process and leaves out the lister it started', async () => {
    const probe = nodeMemoryProbe(process.platform);
    assert.ok(probe.freeMb() > 0);
    const rows = await probe.processes();
    assert.ok(rows !== undefined, 'the host lists its processes');
    assert.ok(treeMb(process.pid, rows) > 0, 'this process is listed with its memory');
    assert.deepEqual(
      treeOf(process.pid, rows).filter((row) => row.pid !== process.pid),
      [],
      'this process has no child left in its list: the lister is left out',
    );
  });
});
