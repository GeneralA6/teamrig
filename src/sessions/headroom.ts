import type { HeadroomConfig } from '../config/types.ts';
import type { CommitCharge } from '../coordinator/memory.ts';
import { KIT_NAME } from '../core/home.ts';

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

/** The middle size (the mean of the two middle ones for an even count), or undefined for none. */
function medianOf(values: readonly number[]): number | undefined {
  const sorted = [...values].sort((a, b) => a - b);
  const high = sorted[Math.floor(sorted.length / 2)];
  const low = sorted[Math.ceil(sorted.length / 2) - 1];
  return high === undefined || low === undefined ? undefined : Math.round((low + high) / 2);
}

/**
 * Whether the host has room for one more session. It is counted at the median running session's tree (what a
 * session holds on this host), else at `sessionMb`: its resident MB against free memory, and its committed MB
 * against the commit charge (a session commits about twice what it holds resident). Free memory must stay over
 * `floorMb` (what queued steps keep free) with it, and the commit charge at most `commitMaxPct` of the limit; a host
 * that gives no commit charge is checked on free memory only.
 */
export function headroomFor(room: HostRoom, floorMb: number, config: HeadroomConfig): Headroom {
  const needMb = medianOf(room.runningMb) ?? config.sessionMb;
  const needCommittedMb = medianOf(room.runningCommittedMb) ?? config.sessionMb;
  const short: string[] = [];
  if (room.freeMb < floorMb + needMb) {
    short.push(`${room.freeMb} MB free, under the ${floorMb} MB queued steps keep free (delivery.queue.memoryFloorMb) plus ${needMb} MB for it`);
  }
  const { commit } = room;
  if (commit !== undefined && (commit.usedMb + needCommittedMb) * 100 > config.commitMaxPct * commit.limitMb) {
    short.push(`with it the commit charge would be ${commit.usedMb + needCommittedMb} MB, over ${config.commitMaxPct}% of its ${commit.limitMb} MB limit (open.headroom.commitMaxPct)`);
  }
  return { needMb, needCommittedMb, short };
}

/** Why `what` (`open web`, `hire web`) is refused: the host's room and how to make some. */
export function noRoomText(what: string, headroom: Headroom): string {
  const counted = `counted at ${headroom.needMb} MB resident and ${headroom.needCommittedMb} MB committed`;
  return `no room on the host to ${what}, ${counted}: ${headroom.short.join('; ')}. Close a session first: ${KIT_NAME} sessions lists what each one holds`;
}
