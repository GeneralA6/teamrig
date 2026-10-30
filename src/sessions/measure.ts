import { treeCommittedMb, treeMb, type ProcessRow } from '../delivery/memory.ts';
import type { SessionRecord } from './record.ts';

/**
 * A session running in a Claude Code process whose tree holds `treeMb` resident and has committed `committedMb`
 * (undefined where the host does not say, as with `ps`).
 */
export interface RunningPlace {
  readonly id: string;
  readonly state: 'running';
  readonly claudePid: number;
  readonly treeMb: number;
  readonly committedMb: number | undefined;
}

/** Where a session is on the host: running, closed, or never recorded. */
export type SessionPlace = RunningPlace | { readonly id: string; readonly state: 'closed' } | { readonly id: string; readonly state: 'unrecorded' };

/** The places that are running, in their order. */
export function runningPlaces(places: readonly SessionPlace[]): RunningPlace[] {
  return places.flatMap((place) => (place.state === 'running' ? [place] : []));
}

/**
 * Each session's place, in the order of `records`, from its record and the host's processes. A session runs while
 * its recorded Claude Code process is listed, did not start after the record (that is a later process given the
 * ended one's id), and no other session recorded the same process later (a /clear that bound the tab to it).
 */
export function measureSessions(records: ReadonlyMap<string, SessionRecord | undefined>, rows: readonly ProcessRow[]): SessionPlace[] {
  const owners = new Map<number, { readonly id: string; readonly atMs: number }>();
  for (const [id, record] of records) {
    const owner = record === undefined ? undefined : owners.get(record.claudePid);
    if (record !== undefined && (owner === undefined || Date.parse(record.at) > owner.atMs)) {
      owners.set(record.claudePid, { id, atMs: Date.parse(record.at) });
    }
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return [...records].map(([id, record]): SessionPlace => {
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
