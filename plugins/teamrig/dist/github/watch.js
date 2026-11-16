import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
import { compareVersions, parseVersion } from "../core/release-version.js";
/**
 * `issue watch`'s decisions, kept pure: who holds the one watch a team runs (`leaseHeld`), when a probe's answer
 * calls for the full sync (`readDue`), when a watch with no live session to serve stops (`idleDone`), and when a
 * watch's code is too old to keep (`leaseOutdated`, `lifetimeDone`).
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
 * A watch stops once it ran this long, and the next hook starts a fresh one. The watch is the one process that writes
 * to GitHub with no person behind it, so a fix to what it may run or write must reach it within a day even where some
 * session always runs and the idle stop never comes (security T3093 F1, beside the version takeover).
 */
export const LIFETIME_MS = 24 * 60 * MINUTE_MS;
/** The lease in a file's text; undefined for no file, a damaged one, or another format. */
export function parseWatchLease(text) {
    const record = parseObject(text.trim());
    if (record === undefined || record[VERSION_FIELD] !== WATCH_LEASE_FORMAT) {
        return undefined;
    }
    const { pid, kitVersion, startedAt, beatAt } = record;
    if (typeof kitVersion !== 'string' || !isTime(startedAt) || !isTime(beatAt) || !(pid === undefined || isPid(pid))) {
        return undefined;
    }
    return { pid, kitVersion, startedAt, beatAt };
}
export function formatWatchLease(lease) {
    return toJsonlLine({
        [VERSION_FIELD]: WATCH_LEASE_FORMAT,
        ...(lease.pid === undefined ? {} : { pid: lease.pid }),
        kitVersion: lease.kitVersion,
        startedAt: lease.startedAt,
        beatAt: lease.beatAt,
    });
}
/**
 * Whether a lease still holds the team's watch: it beat within three probe intervals and the grace. A beat dated
 * ahead of now by more than that (a clock that went back) holds nothing, so a wrong date never stops every watch.
 */
export function leaseHeld(lease, now, probeSeconds) {
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
export function readDue(last, round, now) {
    if (round === 'unchanged') {
        return false;
    }
    if (last === undefined) {
        return true;
    }
    const waited = now < last.at || now - last.at >= RETRY_MS;
    return round === 'changed' ? last.ok || waited : waited;
}
/**
 * Whether a lease is a watch of older code than `kitVersion`, which the caller takes over: after an update the next
 * hook starts the new code, and the old watch stops at its next beat. A newer or equal lease is kept, so two kit
 * versions running side by side never take it from each other in turns; a version that does not read as one is older.
 */
export function leaseOutdated(lease, kitVersion) {
    const ours = parseVersion(kitVersion);
    const theirs = parseVersion(lease.kitVersion);
    if (ours === undefined) {
        return false;
    }
    return theirs === undefined || compareVersions(theirs, ours) < 0;
}
/** Whether a watch that started at `startedAt` ran its LIFETIME_MS; a start dated ahead of now never ends it. */
export function lifetimeDone(startedAt, now) {
    return now - startedAt >= LIFETIME_MS;
}
/** Whether a watch whose team had no live session since `idleSince` stops now. */
export function idleDone(idleSince, now) {
    return idleSince !== undefined && now - idleSince >= IDLE_STOP_MS;
}
function isTime(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isPid(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
