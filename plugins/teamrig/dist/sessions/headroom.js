import { KIT_NAME } from "../core/home.js";
/** The middle size (the mean of the two middle ones for an even count), or undefined for none. */
function medianOf(values) {
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
export function headroomFor(room, floorMb, config) {
    const needMb = medianOf(room.runningMb) ?? config.sessionMb;
    const needCommittedMb = medianOf(room.runningCommittedMb) ?? config.sessionMb;
    const short = [];
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
export function noRoomText(what, headroom) {
    const counted = `counted at ${headroom.needMb} MB resident and ${headroom.needCommittedMb} MB committed`;
    return `no room on the host to ${what}, ${counted}: ${headroom.short.join('; ')}. Close a session first: ${KIT_NAME} sessions lists what each one holds`;
}
