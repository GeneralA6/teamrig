import type { Sleep } from '../core/lock.ts';
import type { CommitCharge, MemoryProbe } from './memory.ts';

/** What the gate reads of the host: its free memory, its RAM and its commit charge. */
export type GateProbe = Pick<MemoryProbe, 'freeMb' | 'totalMb' | 'commit'>;

/** The gate's limits, from the team config. */
export interface MemoryGateConfig {
  /** The MB the host keeps free besides what is held for the steps on it (delivery.queue.memoryFloorMb). */
  readonly floorMb: number;
  /** The MB held for a heavy step, a merge or a deploy that asks for no more (delivery.queue.heavyReserveMb). */
  readonly heavyReserveMb: number;
  /** The most of the commit limit, in %, the commit charge may reach with the step counted (open.headroom.commitMaxPct). */
  readonly commitMaxPct: number;
}

/**
 * Free memory too low for the step: the least free memory read, the MB held for the small steps sharing the host, and
 * the MB the step needs free besides them (`floorMb` plus `reserveMb`, or half the host's `hostMb` of RAM when that is
 * less, so a small host can still run a step).
 */
export interface MemoryShort {
  readonly kind: 'memory';
  readonly freeMb: number;
  readonly heldMb: number;
  readonly needMb: number;
  readonly floorMb: number;
  readonly reserveMb: number;
  /** The host's RAM, set when the need is half of it. */
  readonly hostMb?: number;
  /** Where `reserveMb` came from (`StepNeed.basis`), when the step's need says. */
  readonly basis?: string;
}

/** A commit charge that would pass `maxPct` of its limit with the step's `reserveMb` counted. */
export interface CommitShort extends CommitCharge {
  readonly kind: 'commit';
  readonly maxPct: number;
  readonly reserveMb: number;
  /** Where `reserveMb` came from (`StepNeed.basis`), when the step's need says. */
  readonly basis?: string;
}

/** What one look found: room for the step, with the least free memory read; or why it must wait. */
export type MemoryLook = { readonly kind: 'room'; readonly freeMb: number } | MemoryShort | CommitShort;

/**
 * Free memory is read this many times, `READ_GAP_MS` apart, and the least read counts: a step that just ended gives
 * back its memory in a burst, and a step that just started takes it in one, so a single read can catch either.
 */
export const FREE_READS = 3;
export const READ_GAP_MS = 1_000;

/**
 * Whether the host has the memory for one more step: free memory over the floor plus the step's reserve, the
 * small steps' held MB counted as taken, and room under the commit limit for its reserve. A short first read ends the
 * look at once; the commit charge, a slow read on Windows (a PowerShell call), is read only once free memory clears.
 */
export class MemoryGate {
  readonly config: MemoryGateConfig;
  private readonly probe: GateProbe;
  private readonly sleep: Sleep;

  constructor(probe: GateProbe, sleep: Sleep, config: MemoryGateConfig) {
    this.probe = probe;
    this.sleep = sleep;
    this.config = config;
  }

  /** One look for a step that holds `reserveMb` beside the `heldMb` held for the small steps on the host. */
  async look(reserveMb: number, heldMb: number): Promise<MemoryLook> {
    const { floorMb, commitMaxPct } = this.config;
    const hostMb = this.probe.totalMb();
    const capped = (floorMb + reserveMb) * 2 > hostMb;
    const needMb = capped ? Math.floor(hostMb / 2) : floorMb + reserveMb;
    let freeMb = this.probe.freeMb();
    for (let read = 1; freeMb - heldMb >= needMb; read += 1) {
      if (read === FREE_READS) {
        const commit = await this.probe.commit();
        if (commit !== undefined && (commit.usedMb + reserveMb) * 100 > commitMaxPct * commit.limitMb) {
          return { kind: 'commit', ...commit, maxPct: commitMaxPct, reserveMb };
        }
        return { kind: 'room', freeMb };
      }
      await this.sleep(READ_GAP_MS);
      freeMb = Math.min(freeMb, this.probe.freeMb());
    }
    return { kind: 'memory', freeMb, heldMb, needMb, floorMb, reserveMb, ...(capped ? { hostMb } : {}) };
  }
}

/**
 * Why a step waits on the host's memory, as a session reads it, `sharing` the number of small steps the held MB is
 * for: `host memory: 6000 MB free, 2048 MB held for it, 6144 MB needed (4096 floor + 2048 for this step)`, or
 * `host commit charge: 30000 of 32000 MB, 2048 MB more for this step would pass 92% (open.headroom.commitMaxPct)`.
 * A step's MB is followed by its basis, when it has one: `(4096 floor + 7500 for this step, learned from 12 runs)`.
 */
export function shortText(short: MemoryShort | CommitShort, sharing: number): string {
  if (short.kind === 'commit') {
    const basis = short.basis === undefined ? '' : ` (${short.basis})`;
    return `host commit charge: ${short.usedMb} of ${short.limitMb} MB, ${short.reserveMb} MB more for this step${basis} would pass ${short.maxPct}% (open.headroom.commitMaxPct)`;
  }
  const held = sharing === 0 ? '' : `, ${short.heldMb} MB held for ${sharing === 1 ? 'it' : 'them'}`;
  const basis = short.basis === undefined ? '' : `, ${short.basis}`;
  const need = short.hostMb === undefined ? `${short.floorMb} floor + ${short.reserveMb} for this step${basis}` : `half the host's ${short.hostMb} MB`;
  return `host memory: ${short.freeMb} MB free${held}, ${short.needMb} MB needed (${need})`;
}
