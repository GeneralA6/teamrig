import { formatUtcMinute } from "../core/time.js";
import { freezeEndText, parseFreezes } from "./freezes.js";
import { holderText } from "./host-lock.js";
/** The freezes for people to read, beside `claims.json`, and the lock their writers share. */
export const CLAIMS_MD_FILE = 'claims.md';
export const CLAIMS_LOCK_FILE = 'claims.lock';
/** The freezes are written under their own lock, held for one read and write: it lasts 60 s and is waited for 15 s. */
export const FREEZES_LOCK_TTL_MS = 60_000;
const FREEZES_LOCK_WAIT_MS = 15_000;
const FREEZES_LOCK_POLL_MS = 500;
/** The first line of `claims.md`, as a team's own deploy tool writes it, in the old name of a deploy freeze. */
export const CLAIMS_MD_HEADER = '# Quiet claims: active only until their end time (see README.md, rule 3)';
/** Text on one line, its runs of whitespace one space, since each freeze is one line of `claims.md`. */
function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
/** Why a freeze cannot be made whatever the freezes file holds; undefined when it can. */
export function freezeRefusal(request, rules) {
    if (!Number.isInteger(request.minutes) || request.minutes <= 0 || request.minutes > rules.maxMinutes) {
        return `a freeze lasts 1 to ${rules.maxMinutes} minutes (asked ${request.minutes})`;
    }
    if (request.targets.length === 0) {
        return 'a freeze names at least one deploy target';
    }
    const unknown = request.targets.filter((target) => !rules.knownTargets.includes(target));
    if (unknown.length > 0) {
        const known = rules.knownTargets.length === 0 ? 'none are configured' : `known: ${rules.knownTargets.join(', ')}`;
        return `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a deploy target' : 'are not deploy targets'} of this team (${known})`;
    }
    if (oneLine(request.metric) === '') {
        return 'a freeze names the metric it measures';
    }
    if (oneLine(request.why) === '') {
        return 'a freeze says why it holds deploys';
    }
    return rules.scanner.refusal('the metric', request.metric) ?? rules.scanner.refusal('the reason', request.why);
}
/** An ISO time as `claims.md` shows it, `2030-01-08 10:00`; text that is no time stays as it is. */
function shownTime(iso) {
    const at = Date.parse(iso);
    return Number.isNaN(at) ? iso : formatUtcMinute(new Date(at));
}
/** `claims.md`: its header, then `- <from> → <until> | <session> | <targets> | <metric> | <why>` a freeze, times in UTC. */
export function renderClaimsMd(freezes) {
    const lines = freezes.map((freeze) => `- ${shownTime(freeze.from)} → ${shownTime(freeze.until)} | ${freeze.session} | ${freeze.targets.join(',')} | ${freeze.metric} | ${freeze.why}`);
    return `${[CLAIMS_MD_HEADER, ...lines].join('\n')}\n`;
}
/**
 * Reads the freezes under their lock, drops the ended ones, applies `change` and writes both files. An unreadable
 * freezes file is left as it is and the change refused, since writing over it would drop the freezes it holds.
 */
async function changeFreezes(ports, places, session, change) {
    const taking = await ports.lock.acquire(session, 'claims write', FREEZES_LOCK_WAIT_MS, FREEZES_LOCK_POLL_MS, () => undefined);
    if (taking.kind === 'busy') {
        return { kind: 'busy', reason: `the freezes are being written (${holderText(taking.holder, ports.zone)}); try again` };
    }
    if (taking.kind === 'withdrawn') {
        return { kind: 'busy', reason: 'its place in line for the freezes was withdrawn; try again' };
    }
    try {
        const read = parseFreezes(await ports.files.read(places.freezes));
        if (read.kind === 'unreadable') {
            return { kind: 'refused', reason: `${places.freezes} is unreadable (${read.reason}), so it is left as it is` };
        }
        const now = ports.clock.now();
        const changed = change(read.freezes.filter((freeze) => Date.parse(freeze.until) > now));
        if (changed.kind === 'refused') {
            return changed;
        }
        await ports.files.write(places.freezes, `${JSON.stringify(changed.freezes, null, 2)}\n`);
        await ports.files.write(places.freezesMd, renderClaimsMd(changed.freezes));
        return { kind: 'done', value: changed.value };
    }
    finally {
        await ports.lock.release(taking.lock);
    }
}
/** Adds the session's freeze, from now for `minutes`: one freeze a session at a time. */
export async function addFreeze(ports, places, rules, request) {
    const refusal = freezeRefusal(request, rules);
    if (refusal !== undefined) {
        return { kind: 'refused', reason: refusal };
    }
    return changeFreezes(ports, places, request.session, (active) => {
        const own = active.find((freeze) => freeze.session === request.session);
        if (own !== undefined) {
            return { kind: 'refused', reason: `${request.session} already holds a freeze until ${freezeEndText(own.until, ports.zone)}; unfreeze it first (one per session)` };
        }
        const now = ports.clock.now();
        const freeze = {
            session: request.session,
            targets: [...request.targets],
            metric: oneLine(request.metric),
            why: oneLine(request.why),
            from: new Date(now).toISOString(),
            until: new Date(now + request.minutes * 60_000).toISOString(),
        };
        return { kind: 'write', freezes: [...active, freeze], value: freeze };
    });
}
/** Ends the session's freeze; done with the freeze it ended, or undefined when it held none. */
export async function endFreeze(ports, places, session) {
    return changeFreezes(ports, places, session, (active) => ({
        kind: 'write',
        freezes: active.filter((freeze) => freeze.session !== session),
        value: active.find((freeze) => freeze.session === session),
    }));
}
