import { cpus } from 'node:os';
import type { Sleep } from '../core/lock.ts';

/** The CPU time the host's cores have spent since it started, summed over every core, in ms: idle, and in all. */
export interface CpuTimes {
  readonly idleMs: number;
  readonly totalMs: number;
}

/** The host's CPU as a queued step reads it. */
export interface HostCpu {
  /** The CPU time spent so far; two reads apart give the share of it idle between them. */
  times(): CpuTimes;
}

/** The host's CPU through node's `os.cpus()`, each core's user, nice, sys, idle and irq time summed. */
export function nodeHostCpu(): HostCpu {
  return {
    times: () => {
      let idleMs = 0;
      let totalMs = 0;
      for (const { times } of cpus()) {
        idleMs += times.idle;
        totalMs += times.user + times.nice + times.sys + times.idle + times.irq;
      }
      return { idleMs, totalMs };
    },
  };
}

/** What one look found: room for one more heavy step, or a host too busy for it; `idlePct` the share of CPU time idle between the reads. */
export type CpuLook = { readonly kind: 'room'; readonly idlePct: number } | { readonly kind: 'cpu'; readonly idlePct: number; readonly needPct: number };

/**
 * The CPU is read twice this far apart: a test run fans out over every core in bursts, so a shorter gap catches a lull
 * or a burst alone.
 */
export const CPU_READ_GAP_MS = 2_000;

/**
 * Whether the host has CPU room for one more heavy step (T2700): the share of CPU time idle between two reads
 * `CPU_READ_GAP_MS` apart is at least `needPct` (`delivery.queue.heavyIdleCpuPct`). Two heavy steps each fanning a test
 * run out over every core slow both until their wall-clock limits fire, which memory alone does not show. A `needPct`
 * of 0 lets every step in unread, and so does a host whose CPU time did not move between the reads (nothing to judge by).
 */
export class CpuGate {
  readonly needPct: number;
  private readonly cpu: HostCpu;
  private readonly sleep: Sleep;

  constructor(cpu: HostCpu, sleep: Sleep, needPct: number) {
    this.cpu = cpu;
    this.sleep = sleep;
    this.needPct = needPct;
  }

  async look(): Promise<CpuLook> {
    if (this.needPct === 0) {
      return { kind: 'room', idlePct: 100 };
    }
    const before = this.cpu.times();
    await this.sleep(CPU_READ_GAP_MS);
    const after = this.cpu.times();
    const totalMs = after.totalMs - before.totalMs;
    if (totalMs <= 0) {
      return { kind: 'room', idlePct: 100 };
    }
    const idlePct = Math.round(((after.idleMs - before.idleMs) * 100) / totalMs);
    return idlePct >= this.needPct ? { kind: 'room', idlePct } : { kind: 'cpu', idlePct, needPct: this.needPct };
  }
}
