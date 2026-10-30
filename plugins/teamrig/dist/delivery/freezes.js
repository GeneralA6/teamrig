import { isRecord, isStringArray, stringField } from "../core/guards.js";
/** The deploy freezes' file in the delivery folder, named for their old name, quiet claims: one JSON array, written whole. */
export const CLAIMS_FILE = 'claims.json';
function freezeOf(value) {
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
 * The freezes in the file's text; an entry missing a field is skipped, as its writer skips one. Text that is no JSON
 * array (a file caught mid-write) is unreadable, never "no freezes", so a deploy waits rather than runs through a freeze.
 */
export function parseFreezes(text) {
    if (text === undefined) {
        return { kind: 'read', freezes: [] };
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
    return { kind: 'read', freezes: parsed.flatMap((value) => freezeOf(value) ?? []) };
}
export async function readFreezes(files, path) {
    return parseFreezes(await files.read(path));
}
/** The freezes still holding at `nowMs` that name one of `targets`. */
export function coveringFreezes(freezes, targets, nowMs) {
    return freezes.filter((freeze) => Date.parse(freeze.until) > nowMs && freeze.targets.some((target) => targets.includes(target)));
}
/** When a freeze ends, on `zone`'s clock; a stored end that is not a time is shown as written. */
export function freezeEndText(until, zone) {
    const at = Date.parse(until);
    return Number.isNaN(at) ? until : zone.minute(new Date(at));
}
/** `by po on cloud-api until 2030-01-08 12:00 UTC (p95 latency)`: who holds a freeze, on what, until when (on `zone`'s clock) and for what. */
function heldText(freeze, zone) {
    return `by ${freeze.session} on ${freeze.targets.join(',')} until ${freezeEndText(freeze.until, zone)} (${freeze.metric})`;
}
/** `deploy freeze by po on cloud-api until 2030-01-08 12:00 UTC (p95 latency)`, the reason a merge or a deploy waits. */
export function freezeText(freeze, zone) {
    return `deploy freeze ${heldText(freeze, zone)}`;
}
/**
 * `quiet claim by po on cloud-api until 2030-01-08 12:00 UTC (p95 latency)`, a freeze's line in `teamrig deploy-status`,
 * which keeps the old name of a deploy freeze (T1308): outside tools read that page, and its lines change only after
 * they are told.
 */
export function quietClaimText(freeze, zone) {
    return `quiet claim ${heldText(freeze, zone)}`;
}
