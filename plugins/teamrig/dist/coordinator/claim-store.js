import { formatUtcMinute } from "../core/time.js";
import { claimEndText, parseClaims } from "./claims.js";
import { holderText } from "./host-lock.js";
/** The claims for people to read, beside `claims.json`, and the lock their writers share. */
export const CLAIMS_MD_FILE = 'claims.md';
export const CLAIMS_LOCK_FILE = 'claims.lock';
/** The claims are written under their own lock, held for one read and write: it lasts 60 s and is waited for 15 s. */
export const CLAIMS_LOCK_TTL_MS = 60_000;
const CLAIMS_LOCK_WAIT_MS = 15_000;
const CLAIMS_LOCK_POLL_MS = 500;
/** The first line of `claims.md`, as the team's own coordinator writes it. */
export const CLAIMS_MD_HEADER = '# Quiet claims: active only until their end time (see README.md, rule 3)';
/** Text on one line, its runs of whitespace one space, since each claim is one line of `claims.md`. */
function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
/** Why a claim cannot be made whatever the claims file holds; undefined when it can. */
export function claimRefusal(request, rules) {
    if (!Number.isInteger(request.minutes) || request.minutes <= 0 || request.minutes > rules.maxMinutes) {
        return `a claim lasts 1 to ${rules.maxMinutes} minutes (asked ${request.minutes})`;
    }
    if (request.targets.length === 0) {
        return 'a claim names at least one deploy target';
    }
    const unknown = request.targets.filter((target) => !rules.knownTargets.includes(target));
    if (unknown.length > 0) {
        const known = rules.knownTargets.length === 0 ? 'none are configured' : `known: ${rules.knownTargets.join(', ')}`;
        return `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a deploy target' : 'are not deploy targets'} of this team (${known})`;
    }
    if (oneLine(request.metric) === '') {
        return 'a claim names the metric it measures';
    }
    if (oneLine(request.why) === '') {
        return 'a claim says why it holds deploys';
    }
    return rules.scanner.refusal('the metric', request.metric) ?? rules.scanner.refusal('the reason', request.why);
}
/** An ISO time as `claims.md` shows it, `2030-01-08 10:00`; text that is no time stays as it is. */
function shownTime(iso) {
    const at = Date.parse(iso);
    return Number.isNaN(at) ? iso : formatUtcMinute(new Date(at));
}
/** `claims.md`: its header, then `- <from> → <until> | <session> | <targets> | <metric> | <why>` a claim, times in UTC. */
export function renderClaimsMd(claims) {
    const lines = claims.map((claim) => `- ${shownTime(claim.from)} → ${shownTime(claim.until)} | ${claim.session} | ${claim.targets.join(',')} | ${claim.metric} | ${claim.why}`);
    return `${[CLAIMS_MD_HEADER, ...lines].join('\n')}\n`;
}
/**
 * Reads the claims under their lock, drops the ended ones, applies `change` and writes both files. An unreadable
 * claims file is left as it is and the change refused, since writing over it would drop the claims it holds.
 */
async function changeClaims(ports, places, session, change) {
    const taking = await ports.lock.acquire(session, 'claims write', CLAIMS_LOCK_WAIT_MS, CLAIMS_LOCK_POLL_MS, () => undefined);
    if (taking.kind === 'busy') {
        return { kind: 'busy', reason: `the claims are being written (${holderText(taking.holder, ports.zone)}); try again` };
    }
    if (taking.kind === 'withdrawn') {
        return { kind: 'busy', reason: 'its place in line for the claims was withdrawn; try again' };
    }
    try {
        const read = parseClaims(await ports.files.read(places.claims));
        if (read.kind === 'unreadable') {
            return { kind: 'refused', reason: `${places.claims} is unreadable (${read.reason}), so it is left as it is` };
        }
        const now = ports.clock.now();
        const changed = change(read.claims.filter((claim) => Date.parse(claim.until) > now));
        if (changed.kind === 'refused') {
            return changed;
        }
        await ports.files.write(places.claims, `${JSON.stringify(changed.claims, null, 2)}\n`);
        await ports.files.write(places.claimsMd, renderClaimsMd(changed.claims));
        return { kind: 'done', value: changed.value };
    }
    finally {
        await ports.lock.release(taking.lock);
    }
}
/** Adds the session's claim, from now for `minutes`: one claim a session at a time. */
export async function addClaim(ports, places, rules, request) {
    const refusal = claimRefusal(request, rules);
    if (refusal !== undefined) {
        return { kind: 'refused', reason: refusal };
    }
    return changeClaims(ports, places, request.session, (active) => {
        const own = active.find((claim) => claim.session === request.session);
        if (own !== undefined) {
            return { kind: 'refused', reason: `${request.session} already holds a claim until ${claimEndText(own.until, ports.zone)}; release it first (one per session)` };
        }
        const now = ports.clock.now();
        const claim = {
            session: request.session,
            targets: [...request.targets],
            metric: oneLine(request.metric),
            why: oneLine(request.why),
            from: new Date(now).toISOString(),
            until: new Date(now + request.minutes * 60_000).toISOString(),
        };
        return { kind: 'write', claims: [...active, claim], value: claim };
    });
}
/** Ends the session's claim; done with the claim it ended, or undefined when it held none. */
export async function releaseClaim(ports, places, session) {
    return changeClaims(ports, places, session, (active) => ({
        kind: 'write',
        claims: active.filter((claim) => claim.session !== session),
        value: active.find((claim) => claim.session === session),
    }));
}
