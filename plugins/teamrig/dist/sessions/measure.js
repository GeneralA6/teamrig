import { treeCommittedMb, treeMb } from "../delivery/memory.js";
/** The places that are running, in their order. */
export function runningPlaces(places) {
    return places.flatMap((place) => (place.state === 'running' ? [place] : []));
}
/**
 * Each session's place, in the order of `records`, from its record and the host's processes. A session runs while
 * its recorded Claude Code process is listed, did not start after the record (that is a later process given the
 * ended one's id), and no other session recorded the same process later (a /clear that bound the tab to it).
 */
export function measureSessions(records, rows) {
    const owners = new Map();
    for (const [id, record] of records) {
        const owner = record === undefined ? undefined : owners.get(record.claudePid);
        if (record !== undefined && (owner === undefined || Date.parse(record.at) > owner.atMs)) {
            owners.set(record.claudePid, { id, atMs: Date.parse(record.at) });
        }
    }
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    return [...records].map(([id, record]) => {
        if (record === undefined) {
            return { id, state: 'unrecorded' };
        }
        const row = byPid.get(record.claudePid);
        const sameProcess = row !== undefined && (row.startedMs === undefined || row.startedMs <= Date.parse(record.at));
        return sameProcess && owners.get(record.claudePid)?.id === id
            ? { id, state: 'running', claudePid: record.claudePid, treeMb: treeMb(record.claudePid, rows), committedMb: treeCommittedMb(record.claudePid, rows) }
            : { id, state: 'closed' };
    });
}
