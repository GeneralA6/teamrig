import type { HeadroomConfig, QueueConfig } from '../config/types.ts';
import type { CommitCharge } from '../delivery/memory.ts';
import { tabsText, type LoadingTab } from '../delivery/memory-gate.ts';
import { KIT_NAME } from '../core/home.ts';

export type { LoadingTab };

/** What the host holds as one more session is about to be added. */
export interface HostRoom {
  /** The host's free memory, in MB. */
  readonly freeMb: number;
  /** The host's commit charge; undefined where it gives none. */
  readonly commit: CommitCharge | undefined;
  /** The MB each running session's Claude Code process tree holds: none when none runs or the host cannot list them. */
  readonly runningMb: readonly number[];
  /** The MB each running session's tree has committed: none when none runs or the host does not say (a `ps` list). */
  readonly runningCommittedMb: readonly number[];
  /** Every team's tabs opened and still loading (src/sessions/tab-holds.ts): free memory and the commit charge lag them. */
  readonly loading: readonly LoadingTab[];
}

/**
 * One more session's fit: the MB it is counted to take from free memory (`needMb`) and to add to the commit charge
 * (`needCommittedMb`), and each reason the host has no room for it (none: it fits).
 */
export interface Headroom {
  readonly needMb: number;
  readonly needCommittedMb: number;
  readonly short: readonly string[];
}

/** The MB free memory keeps with a new tab, and the config key it comes from, as a refusal names it. */
export interface TabFloor {
  readonly mb: number;
  readonly key: string;
}

/**
 * The floor a new tab leaves free: `open.headroom.floorMb` when set, else what queued steps keep free plus one heavy
 * step's reserve, so a tab opened at the floor still leaves a heavy step the room the host lock admits it at.
 */
export function tabFloorOf(headroom: Pick<HeadroomConfig, 'floorMb'>, queue: Pick<QueueConfig, 'memoryFloorMb' | 'heavyReserveMb'>): TabFloor {
  if (headroom.floorMb !== undefined) {
    return { mb: headroom.floorMb, key: 'open.headroom.floorMb' };
  }
  return {
    mb: queue.memoryFloorMb + queue.heavyReserveMb,
    key: 'delivery.queue.memoryFloorMb + heavyReserveMb, while open.headroom.floorMb is unset',
  };
}

/** The middle size (the mean of the two middle ones for an even count), or undefined for none. */
function medianOf(values: readonly number[]): number | undefined {
  const sorted = [...values].sort((a, b) => a - b);
  const high = sorted[Math.floor(sorted.length / 2)];
  const low = sorted[Math.ceil(sorted.length / 2) - 1];
  return high === undefined || low === undefined ? undefined : Math.round((low + high) / 2);
}

function sumOf(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

/**
 * Whether the host has room for one more session. It is counted at the median running session's tree (what a
 * session holds on this host), else at `sessionMb`: its resident MB against free memory, and its committed MB
 * against the commit charge (a session commits about twice what it holds resident). The tabs still loading hold
 * their MB of both, since the host shows neither yet. Free memory less those holds must stay over `floor` with it,
 * and the commit charge with the holds at most `commitMaxPct` of the limit; a host that gives no commit charge is
 * checked on free memory only.
 */
export function headroomFor(room: HostRoom, floor: TabFloor, config: HeadroomConfig): Headroom {
  const needMb = medianOf(room.runningMb) ?? config.sessionMb;
  const needCommittedMb = medianOf(room.runningCommittedMb) ?? config.sessionMb;
  const heldMb = sumOf(room.loading.map((tab) => tab.needMb));
  const heldCommittedMb = sumOf(room.loading.map((tab) => tab.needCommittedMb));
  const loading = tabsText(room.loading.length);
  const short: string[] = [];
  if (room.freeMb - heldMb < floor.mb + needMb) {
    const held = room.loading.length === 0 ? '' : `, ${heldMb} MB of it held for ${loading} still loading`;
    short.push(`${room.freeMb} MB free${held}, under the ${floor.mb} MB a new tab keeps free (${floor.key}) plus ${needMb} MB for it`);
  }
  const { commit } = room;
  const committed = commit === undefined ? 0 : commit.usedMb + heldCommittedMb + needCommittedMb;
  if (commit !== undefined && committed * 100 > config.commitMaxPct * commit.limitMb) {
    const held = room.loading.length === 0 ? '' : ` and the ${loading} still loading`;
    short.push(`with it${held} the commit charge would be ${committed} MB, over ${config.commitMaxPct}% of its ${commit.limitMb} MB limit (open.headroom.commitMaxPct)`);
  }
  return { needMb, needCommittedMb, short };
}

/** Why `what` (`open web`, `hire web`) is refused: the host's room and how to make some. */
export function noRoomText(what: string, headroom: Headroom): string {
  const counted = `counted at ${headroom.needMb} MB resident and ${headroom.needCommittedMb} MB committed`;
  return `no room on the host to ${what}, ${counted}: ${headroom.short.join('; ')}. Close a session first: ${KIT_NAME} sessions lists what each one holds`;
}
