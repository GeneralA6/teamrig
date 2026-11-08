import { DEFAULT_HEADROOM, DEFAULT_QUEUE } from '../config/defaults.ts';
import type { Sleep } from '../core/lock.ts';
import type { CommitCharge, HostMemory, MemoryHolder, MemoryPeaks, MemoryWatch, ProcessRow } from '../delivery/memory.ts';
import { MemoryGate } from '../delivery/memory-gate.ts';

/** One watch a step started: its root and interval, and whether it was stopped. */
export interface FakeWatch {
  readonly root: number;
  readonly intervalMs: number;
  stopped: boolean;
}

/** A busy host's programs by the memory they hold, most first: more than a refusal names. */
export const BUSY_HOLDERS: readonly MemoryHolder[] = [
  { name: 'vmmem', mb: 22_938, processes: 1 },
  { name: 'msedge', mb: 21_402, processes: 35 },
  { name: 'claude', mb: 900, processes: 12 },
  { name: 'node', mb: 400, processes: 3 },
];

/** How a refusal names `BUSY_HOLDERS`: the top three. */
export const BUSY_HOLDERS_TEXT = 'top memory holders: vmmem 22.4 GB, msedge 20.9 GB in 35 processes, claude 900 MB in 12 processes';

/**
 * Host memory whose free and total memory, processes, commit charge, memory holders and watch results the test sets:
 * by default it has `free` (8000) MB free of 32 GB of RAM, lists no process and no holder, has no commit charge and its
 * watches measure nothing, as with sampling off. Each watch and each look at the holders is recorded.
 */
export class FakeHostMemory implements HostMemory {
  free: number;
  total = 32768;
  peaks: MemoryPeaks = {};
  rows: readonly ProcessRow[] | undefined = [];
  charge: CommitCharge | undefined;
  named: readonly MemoryHolder[] | undefined = [];
  readonly watches: FakeWatch[] = [];
  /** How many times the holders were asked for. */
  holderLooks = 0;
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

  /** From now on, the host's programs hold memory as `holders` says (undefined: they cannot be listed). */
  holds(holders: readonly MemoryHolder[] | undefined): this {
    this.named = holders;
    return this;
  }

  async holders(): Promise<readonly MemoryHolder[] | undefined> {
    this.holderLooks += 1;
    return this.named;
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

/** The memory gate the CLI puts on the host lock under the default config (`hostLockOf`), reading `memory`. */
export function defaultGateOn(memory: FakeHostMemory, sleep: Sleep): MemoryGate {
  return new MemoryGate(memory, sleep, { floorMb: DEFAULT_QUEUE.memoryFloorMb, heavyReserveMb: DEFAULT_QUEUE.heavyReserveMb, commitMaxPct: DEFAULT_HEADROOM.commitMaxPct });
}
