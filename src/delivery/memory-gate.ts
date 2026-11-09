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
 * A session's tab opened and still loading (src/sessions/tab-holds.ts): the MB it is counted to take from free memory
 * and to add to the commit charge, which the host does not show yet.
 */
export interface LoadingTab {
  readonly needMb: number;
  readonly needCommittedMb: number;
}

/** Every team's tabs still loading on the host, read at each look. */
export type LoadingTabs = () => Promise<readonly LoadingTab[]>;

/** The tabs still loading a short look counted: how many, and the MB held for them of what it was short of. */
export interface HeldForTabs {
  readonly tabs: number;
  readonly mb: number;
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
  /** The tabs still loading, their MB of free memory held besides `heldMb`; set when any load. */
  readonly loading?: HeldForTabs;
}

/** A commit charge that would pass `maxPct` of its limit with the step's `reserveMb` counted. */
export interface CommitShort extends CommitCharge {
  readonly kind: 'commit';
  readonly maxPct: number;
  readonly reserveMb: number;
  /** Where `reserveMb` came from (`StepNeed.basis`), when the step's need says. */
  readonly basis?: string;
  /** The tabs still loading, their MB of the commit charge counted on top of `usedMb`; set when any load. */
  readonly loading?: HeldForTabs;
}

/** What one look found: room for the step, with the least free memory read; or why it must wait. */
export type MemoryLook = { readonly kind: 'room'; readonly freeMb: number } | MemoryShort | CommitShort;

/**
 * Free memory is read this many times, `READ_GAP_MS` apart, and the least read counts: a step that just ended gives
 * back its memory in a burst, and a step that just started takes it in one, so a single read can catch either.
 */
export const FREE_READS = 3;
export const READ_GAP_MS = 1_000;

/** `{ loading }` for the tabs that hold `mb`, or nothing when none load. */
function loadingOf(tabs: readonly LoadingTab[], mb: number): { readonly loading?: HeldForTabs } {
  return tabs.length === 0 ? {} : { loading: { tabs: tabs.length, mb } };
}

/**
 * Whether the host has the memory for one more step: free memory over the floor plus the step's reserve, the
 * small steps' held MB counted as taken, and room under the commit limit for its reserve. The tabs still loading
 * (`loading`) hold their MB of both, as a tab opened just before the step shows in neither yet (T2199). A short first
 * read ends the look at once; the commit charge, a slow read on Windows (a PowerShell call), is read only once free
 * memory clears.
 */
export class MemoryGate {
  readonly config: MemoryGateConfig;
  private readonly probe: GateProbe;
  private readonly sleep: Sleep;
  private readonly loading: LoadingTabs;

  constructor(probe: GateProbe, sleep: Sleep, config: MemoryGateConfig, loading: LoadingTabs) {
    this.probe = probe;
    this.sleep = sleep;
    this.config = config;
    this.loading = loading;
  }

  /** One look for a step that holds `reserveMb` beside the `heldMb` held for the small steps on the host and the tabs still loading. */
  async look(reserveMb: number, heldMb: number): Promise<MemoryLook> {
    const { floorMb, commitMaxPct } = this.config;
    const tabs = await this.loading();
    const tabsMb = tabs.reduce((total, tab) => total + tab.needMb, 0);
    const hostMb = this.probe.totalMb();
    const capped = (floorMb + reserveMb) * 2 > hostMb;
    const needMb = capped ? Math.floor(hostMb / 2) : floorMb + reserveMb;
    let freeMb = this.probe.freeMb();
    for (let read = 1; freeMb - heldMb - tabsMb >= needMb; read += 1) {
      if (read === FREE_READS) {
        const commit = await this.probe.commit();
        const tabsCommittedMb = tabs.reduce((total, tab) => total + tab.needCommittedMb, 0);
        if (commit !== undefined && (commit.usedMb + tabsCommittedMb + reserveMb) * 100 > commitMaxPct * commit.limitMb) {
          return { kind: 'commit', ...commit, maxPct: commitMaxPct, reserveMb, ...loadingOf(tabs, tabsCommittedMb) };
        }
        return { kind: 'room', freeMb };
      }
      await this.sleep(READ_GAP_MS);
      freeMb = Math.min(freeMb, this.probe.freeMb());
    }
    return { kind: 'memory', freeMb, heldMb, needMb, floorMb, reserveMb, ...(capped ? { hostMb } : {}), ...loadingOf(tabs, tabsMb) };
  }
}

/**
 * Why a step waits on the host's memory, as a session reads it, `sharing` the number of small steps the held MB is
 * for: `host memory: 6000 MB free, 2048 MB held for it, 6144 MB needed (4096 floor + 2048 for this step)`, or
 * `host commit charge: 30000 of 32000 MB, 2048 MB more for this step would pass 92% (open.headroom.commitMaxPct)`.
 * A step's MB is followed by its basis, when it has one: `(4096 floor + 7500 for this step, learned from 12 runs)`.
 * The tabs still loading are named after the steps: `…, 1500 MB held for 1 tab still loading, …`.
 */
export function shortText(short: MemoryShort | CommitShort, sharing: number): string {
  const tabs = short.loading === undefined ? '' : `${short.loading.mb} MB held for ${tabsText(short.loading.tabs)} still loading`;
  if (short.kind === 'commit') {
    const basis = short.basis === undefined ? '' : ` (${short.basis})`;
    const held = tabs === '' ? '' : `${tabs} and `;
    return `host commit charge: ${short.usedMb} of ${short.limitMb} MB, ${held}${short.reserveMb} MB more for this step${basis} would pass ${short.maxPct}% (open.headroom.commitMaxPct)`;
  }
  const steps = sharing === 0 ? '' : `, ${short.heldMb} MB held for ${sharing === 1 ? 'it' : 'them'}`;
  const held = tabs === '' ? steps : `${steps}, ${tabs}`;
  const basis = short.basis === undefined ? '' : `, ${short.basis}`;
  const need = short.hostMb === undefined ? `${short.floorMb} floor + ${short.reserveMb} for this step${basis}` : `half the host's ${short.hostMb} MB`;
  return `host memory: ${short.freeMb} MB free${held}, ${short.needMb} MB needed (${need})`;
}

/** `1 tab`, `2 tabs`. */
export function tabsText(count: number): string {
  return count === 1 ? '1 tab' : `${count} tabs`;
}
