import type { HostMemory, MemoryPeaks, MemoryWatch } from '../coordinator/memory.ts';

/** One watch a step started: its root and interval, and whether it was stopped. */
export interface FakeWatch {
  readonly root: number;
  readonly intervalMs: number;
  stopped: boolean;
}

/**
 * Host memory whose free memory and watch results the test sets: by default it measures nothing, as with sampling
 * off. Each watch is recorded; `during` (default nothing) runs when a watch stops, before it reports.
 */
export class FakeHostMemory implements HostMemory {
  free = 8000;
  peaks: MemoryPeaks = {};
  readonly watches: FakeWatch[] = [];

  freeMb(): number {
    return this.free;
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
