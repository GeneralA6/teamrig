import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';

/**
 * `issue watch`'s decisions, kept pure: who holds the one watch a team runs (`leaseHeld`), when a probe's answer
 * calls for the full sync (`readDue`), and when a watch with no live session to serve stops (`idleDone`).
 */

/** The format of the lease file this code writes. */
export const WATCH_LEASE_FORMAT = 1;

const MINUTE_MS = 60_000;
/** A lease's beat counts this long past three probe intervals, room for a slow sync between two beats. */
const LEASE_GRACE_MS = 2 * MINUTE_MS;
/** After a full sync that failed, a change waits this long for the next one, as does a failing probe for any. */
export const RETRY_MS = 15 * MINUTE_MS;
/** A watch stops once no session of its team has run for this long; the next session's hook starts it again. */
export const IDLE_STOP_MS = 10 * MINUTE_MS;

/**
 * The team's one watch: the process that runs it, and when it started and last beat. A hook that starts a watch
 * writes it with no pid, so no other hook starts a second while the first is on its way; the watch then claims it.
 */
export interface WatchLease {
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly beatAt: number;
}

/** The last full sync a watch ran: when, and whether it read every repository. */
export interface LastRead {
  readonly at: number;
  readonly ok: boolean;
}

/** What a round of probes found across the team's repositories. */
export type ProbeRound = 'changed' | 'unchanged' | 'failed';

/** The lease in a file's text; undefined for no file, a damaged one, or another format. */
export function parseWatchLease(text: string): WatchLease | undefined {
  const record = parseObject(text.trim());
  if (record === undefined || record[VERSION_FIELD] !== WATCH_LEASE_FORMAT) {
    return undefined;
  }
  const { pid, startedAt, beatAt } = record;
  if (!isTime(startedAt) || !isTime(beatAt) || !(pid === undefined || isPid(pid))) {
    return undefined;
  }
  return { pid, startedAt, beatAt };
}

export function formatWatchLease(lease: WatchLease): string {
  return toJsonlLine({
    [VERSION_FIELD]: WATCH_LEASE_FORMAT,
    ...(lease.pid === undefined ? {} : { pid: lease.pid }),
    startedAt: lease.startedAt,
    beatAt: lease.beatAt,
  });
}

/**
 * Whether a lease still holds the team's watch: it beat within three probe intervals and the grace. A beat dated
 * ahead of now by more than that (a clock that went back) holds nothing, so a wrong date never stops every watch.
 */
export function leaseHeld(lease: WatchLease | undefined, now: number, probeSeconds: number): boolean {
  if (lease === undefined) {
    return false;
  }
  const window = 3 * probeSeconds * 1000 + LEASE_GRACE_MS;
  return Math.abs(now - lease.beatAt) <= window;
}

/**
 * Whether a round of probes calls for the full sync now. Unchanged never does: the probes are the point. A change
 * does, unless the last sync failed less than RETRY_MS ago, so a lasting failure is not retried every minute. A
 * failed round does once RETRY_MS passed since the last sync, so a repository the probe cannot read is still synced
 * (and its failure told to the lead) as often as a change after a failure would be.
 */
export function readDue(last: LastRead | undefined, round: ProbeRound, now: number): boolean {
  if (round === 'unchanged') {
    return false;
  }
  if (last === undefined) {
    return true;
  }
  const waited = now < last.at || now - last.at >= RETRY_MS;
  return round === 'changed' ? last.ok || waited : waited;
}

/** Whether a watch whose team had no live session since `idleSince` stops now. */
export function idleDone(idleSince: number | undefined, now: number): boolean {
  return idleSince !== undefined && now - idleSince >= IDLE_STOP_MS;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
