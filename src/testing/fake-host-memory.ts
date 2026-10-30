import type { CommitCharge, HostMemory, MemoryPeaks, MemoryWatch, ProcessRow } from '../delivery/memory.ts';

/** One watch a step started: its root and interval, and whether it was stopped. */
export interface FakeWatch {
  readonly root: number;
  readonly intervalMs: number;
  stopped: boolean;
}

/**
 * Host memory whose free memory, processes, commit charge and watch results the test sets: by default it lists no
 * process, has no commit charge and its watches measure nothing, as with sampling off. Each watch is recorded.
 */
export class FakeHostMemory implements HostMemory {
  free = 8000;
  peaks: MemoryPeaks = {};
  rows: readonly ProcessRow[] | undefined = [];
  charge: CommitCharge | undefined;
  readonly watches: FakeWatch[] = [];

  freeMb(): number {
    return this.free;
  }

  /** From now on, the host lists `rows` (undefined: it cannot list them) with commit charge `charge`. */
  lists(rows: readonly ProcessRow[] | undefined, charge?: CommitCharge): this {
    this.rows = rows;
    this.charge = charge;
    return this;
  }

  async processes(): Promise<readonly ProcessRow[] | undefined> {
    return this.rows;
  }

  async commit(): Promise<CommitCharge | undefined> {
    return this.charge;
  }

  /** From now on, each watch reports `peaks`. */
  measures(peaks: MemoryPeaks): this {
    this.peaks = peaks;
    return this;
  }

  watch(root: number, intervalMs: number): MemoryWatch {
    const watch: FakeWatch = { root, intervalMs, stopped: false };
    this.watches.push(watch);
    return {
      stop: async () => {
        watch.stopped = true;
        return this.peaks;
      },
    };
  }
}
