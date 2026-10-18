import { isRecord, isStringArray, stringField } from "../core/guards.js";
import { formatUtcMinute } from "../core/time.js";
/** The quiet claims' file name in the coordinator's folder: one JSON array, written whole. */
export const CLAIMS_FILE = 'claims.json';
function claimOf(value) {
    if (!isRecord(value) || !isStringArray(value['targets'])) {
        return undefined;
    }
    const [session, metric, why, from, until] = ['session', 'metric', 'why', 'from', 'until'].map((key) => stringField(value, key));
    if (session === undefined || metric === undefined || why === undefined || from === undefined || until === undefined) {
        return undefined;
    }
    return { session, targets: value['targets'], metric, why, from, until };
}
/**
 * The claims in the file's text; an entry missing a field is skipped, as its writer skips one. Text that is no JSON
 * array (a file caught mid-write) is unreadable, never "no claims", so a deploy waits rather than runs through a claim.
 */
export function parseClaims(text) {
    if (text === undefined) {
        return { kind: 'read', claims: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { kind: 'unreadable', reason: 'not JSON' };
    }
    if (!Array.isArray(parsed)) {
        return { kind: 'unreadable', reason: 'not a JSON array' };
    }
    return { kind: 'read', claims: parsed.flatMap((value) => claimOf(value) ?? []) };
}
export async function readClaims(files, path) {
    return parseClaims(await files.read(path));
}
/** The claims still holding at `nowMs` that name one of `targets`. */
export function coveringClaims(claims, targets, nowMs) {
    return claims.filter((claim) => Date.parse(claim.until) > nowMs && claim.targets.some((target) => targets.includes(target)));
}
/** `quiet claim by po on cloud-api until 2030-01-08 12:00 UTC (p95 latency)`. */
export function claimText(claim) {
    const until = new Date(Date.parse(claim.until));
    const end = Number.isNaN(until.getTime()) ? claim.until : `${formatUtcMinute(until)} UTC`;
    return `quiet claim by ${claim.session} on ${claim.targets.join(',')} until ${end} (${claim.metric})`;
}
