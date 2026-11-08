import type { CommitCharge, HostMemory, MemoryPeaks, MemoryWatch, ProcessRow } from '../delivery/memory.ts';

/** One watch a step started: its root and interval, and whether it was stopped. */
export interface FakeWatch {
  readonly root: number;
  readonly intervalMs: number;
  stopped: boolean;
}

/**
 * Host memory whose free and total memory, processes, commit charge and watch results the test sets: by default it
 * has `free` (8000) MB free of 32 GB of RAM, lists no process, has no commit charge and its watches measure nothing,
 * as with sampling off. Each watch is recorded.
 */
export class FakeHostMemory implements HostMemory {
  free: number;
  total = 32768;
  peaks: MemoryPeaks = {};
  rows: readonly ProcessRow[] | undefined = [];
  charge: CommitCharge | undefined;
  readonly watches: FakeWatch[] = [];
  private readonly nextFree: number[] = [];

  constructor(free: number = 8000) {
    this.free = free;
  }

  freeMb(): number {
    return this.nextFree.shift() ?? this.free;
  }

  /** The next reads of free memory give `mb` in turn, as memory a running step takes and gives back; later ones `free`. */
  readsFree(...mb: readonly number[]): this {
    this.nextFree.push(...mb);
    return this;
  }

  totalMb(): number {
    return this.total;
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
