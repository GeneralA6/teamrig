import type { CpuTimes, HostCpu } from '../delivery/cpu.ts';

/**
 * Host CPU whose idle share the test sets: each pair of reads a gate takes shows `idlePct` of the CPU time between them
 * idle (100 by default, an idle host); `idles(...)` queues the shares the next looks see, in turn. Each read is counted.
 */
export class FakeHostCpu implements HostCpu {
  idlePct: number;
  reads = 0;
  private readonly next: number[] = [];
  private idleMs = 0;
  private totalMs = 0;
  private pending: number | undefined;

  constructor(idlePct: number = 100) {
    this.idlePct = idlePct;
  }

  /** The next looks see `pct` idle in turn; later ones `idlePct`. */
  idles(...pct: readonly number[]): this {
    this.next.push(...pct);
    return this;
  }

  /** A gate's first read of a look starts a 1000 ms span; its second ends it with the look's idle share. */
  times(): CpuTimes {
    this.reads += 1;
    if (this.pending === undefined) {
      this.pending = this.next.shift() ?? this.idlePct;
    } else {
      this.idleMs += this.pending * 10;
      this.totalMs += 1000;
      this.pending = undefined;
    }
    return { idleMs: this.idleMs, totalMs: this.totalMs };
  }
}
