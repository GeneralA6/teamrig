import { tabsText } from "../delivery/memory-gate.js";
import { KIT_NAME } from "../core/home.js";
import { median } from "../core/quantile.js";
/**
 * The floor a new tab leaves free: `open.headroom.floorMb` when set, else what queued steps keep free plus one heavy
 * step's reserve, so a tab opened at the floor still leaves a heavy step the room the host lock admits it at.
 */
export function tabFloorOf(headroom, queue) {
    if (headroom.floorMb !== undefined) {
        return { mb: headroom.floorMb, key: 'open.headroom.floorMb' };
    }
    return {
        mb: queue.memoryFloorMb + queue.heavyReserveMb,
        key: 'delivery.queue.memoryFloorMb + heavyReserveMb, while open.headroom.floorMb is unset',
    };
}
/** The median size in whole MB, or undefined for none. */
function medianOf(values) {
    const middle = median(values);
    return middle === null ? undefined : Math.round(middle);
}
function sumOf(values) {
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
export function headroomFor(room, floor, config) {
    const needMb = medianOf(room.runningMb) ?? config.sessionMb;
    const needCommittedMb = medianOf(room.runningCommittedMb) ?? config.sessionMb;
    const heldMb = sumOf(room.loading.map((tab) => tab.needMb));
    const heldCommittedMb = sumOf(room.loading.map((tab) => tab.needCommittedMb));
    const loading = tabsText(room.loading.length);
    const short = [];
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
export function noRoomText(what, headroom) {
    const counted = `counted at ${headroom.needMb} MB resident and ${headroom.needCommittedMb} MB committed`;
    return `no room on the host to ${what}, ${counted}: ${headroom.short.join('; ')}. Close a session first: ${KIT_NAME} sessions lists what each one holds`;
}
