import { join } from 'node:path';
import { isRecord } from "../core/guards.js";
import { ENV } from "../core/home.js";
import { KIT_VERSION } from "../core/version.js";
import { shortText } from "./memory-gate.js";
/** Tries per taking: a stale lock removed may be retaken by another step first. */
const ATTEMPTS = 3;
/**
 * How often the first in line looks, at most: it alone may take the lock, so a lock its holder released waits no
 * longer than this for the next step.
 */
export const FIRST_IN_LINE_POLL_MS = 2_000;
/**
 * How long a ticket outlives its step's wait: the last look comes at the wait's end, and no other step may remove the
 * ticket meanwhile, so a step whose live ticket is gone knows it was withdrawn.
 */
export const TICKET_GRACE_MS = 10_000;
/** A ticket's `expiresAt` for a wait that runs out at `deadline`. */
function ticketExpiry(deadline) {
    return new Date(deadline + TICKET_GRACE_MS).toISOString();
}
/** Digits of a ticket's arrival time in its name: enough for any millisecond time, so names sort as times do. */
const ARRIVAL_DIGITS = 15;
/** A ticket's name; a writer's temporary sibling (`<name>.<pid>.<n>.tmp`) does not match. */
const TICKET_NAME = /^\d{15}-[^/\\]+\.json$/;
/** A share's name, its id's; a writer's temporary sibling does not match. */
const SHARE_NAME = /^[^/\\]+\.json$/;
function byAcquiredAt(a, b) {
    return Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt);
}
function isTime(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
/** A record's `kit`: a version, or left out by a writer that does not name one. */
function isKit(value) {
    return value === undefined || typeof value === 'string';
}
/**
 * `value` without a `kit` that is not a version: a team's own deploy tool may write a field of that name for its own
 * use, and a field another writer adds is ignored, never a reason to read its lock as damaged and remove it.
 */
function withoutForeignKit(value) {
    return isRecord(value) && !isKit(value['kit']) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'kit')) : value;
}
/**
 * The name a lock's, a share's and a ticket's id is stored under: `token` until every reader takes `id` (T1544). The
 * secret redactor reads a quoted literal given to `token` as a secret, so a session that shows the lock files a
 * rotation task; but an older teamrig, and a team's own deploy tool, read a lock without `token` as damaged and remove
 * it once it is old enough, and two steps would run at once. So the stored name changes only in a later release, and a
 * reader takes either.
 */
const STORED_ID = 'token';
/**
 * `value` with its id under `id` alone, whichever name its writer stored it under ({@link STORED_ID}); `id` wins in a
 * file holding both. No `token` stays, so a record read and written back (a renewed ticket) stores its id once.
 */
function withId(value) {
    if (!isRecord(value) || !('token' in value)) {
        return value;
    }
    const { token, ...rest } = value;
    return typeof rest['id'] === 'string' || typeof token !== 'string' ? rest : { id: token, ...rest };
}
/** `record` as its file holds it: its id under {@link STORED_ID}. */
function stored(record) {
    const { id, ...rest } = record;
    return JSON.stringify({ [STORED_ID]: id, ...rest });
}
function isHostLockInfo(value) {
    return (isRecord(value) &&
        typeof value['id'] === 'string' &&
        typeof value['pid'] === 'number' &&
        typeof value['session'] === 'string' &&
        typeof value['purpose'] === 'string' &&
        isKit(value['kit']) &&
        isTime(value['acquiredAt']) &&
        isTime(value['expiresAt']));
}
function isLockWaiter(value) {
    return (isRecord(value) &&
        typeof value['id'] === 'string' &&
        typeof value['pid'] === 'number' &&
        typeof value['session'] === 'string' &&
        typeof value['purpose'] === 'string' &&
        isKit(value['kit']) &&
        isTime(value['arrivedAt']) &&
        isTime(value['expiresAt']) &&
        (value['stopsOnWithdraw'] === undefined || typeof value['stopsOnWithdraw'] === 'boolean'));
}
function isHostShare(value) {
    return isHostLockInfo(value) && isRecord(value) && typeof value['reserveMb'] === 'number' && Number.isSafeInteger(value['reserveMb']) && value['reserveMb'] >= 0;
}
function parseAs(text, is) {
    try {
        const value = withId(withoutForeignKit(JSON.parse(text)));
        return is(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function parseLock(text) {
    return parseAs(text, isHostLockInfo);
}
/**
 * `env` for a process a step starts while it holds `lock`: a `teamrig queue` that process starts (a git hook's checks
 * under a commit or a push) runs at once under the same lock, since waiting for it would wait on its own parent.
 */
export function underLock(env, lock) {
    return { ...env, [ENV.hostLock]: lock.id };
}
/**
 * What a waiter waits on as a session reads it: `<session> (<purpose>) since <minute on zone's clock>` for a holder,
 * then its teamrig when another one took the lock (see {@link kitText}), then the small steps it still waits for
 * (`, waiting for 1 small step: <session> (<purpose>) since <minute>`).
 */
export function holderText(holder, zone) {
    switch (holder.kind) {
        case 'held': {
            const waiting = holder.waitsFor === undefined ? '' : `, waiting for ${sharesText(holder.waitsFor, zone)}`;
            return `${holder.info.session} (${holder.info.purpose}) since ${zone.minute(new Date(holder.info.acquiredAt))}${kitText(holder.info.kit)}${waiting}`;
        }
        case 'queued':
            return `${holder.first.session} (${holder.first.purpose}), first in line since ${zone.minute(new Date(holder.first.arrivedAt))}`;
        case 'unknown':
            return 'a writer that has not finished writing';
        case 'draining':
            return sharesText(holder.shares, zone);
        case 'memory':
        case 'commit':
            return `${holder.shares.length === 0 ? '' : `${sharesText(holder.shares, zone)}; `}${shortText(holder, holder.shares.length)}`;
    }
}
/**
 * Nothing for a holder this teamrig took the lock with, else which one did: a version, or none named by a teamrig
 * older than the `kit` field or a team's own deploy tool, which may take a free lock without joining the line.
 */
function kitText(kit) {
    if (kit === KIT_VERSION) {
        return '';
    }
    return kit === undefined ? ', on an older teamrig or another deploy tool' : `, on teamrig ${kit}`;
}
/** The small steps sharing the host: `2 small steps: <session> (<purpose>) since <minute on zone's clock>, ...`. */
export function sharesText(shares, zone) {
    const steps = shares.map((share) => holderText({ kind: 'held', info: share }, zone)).join(', ');
    return `${shares.length} small step${shares.length === 1 ? '' : 's'}: ${steps}`;
}
/** A waiter's report: what it waits on, then how many waiters are ahead of it in line when any are. */
export function waitText(holder, ahead, zone) {
    return ahead === 0 ? holderText(holder, zone) : `${holderText(holder, zone)}; ${ahead} ahead in line`;
}
/** Why a step was refused when its wait ran out: `host memory still short: …` or `host lock still held by …`. */
export function busyText(holder, zone) {
    return holder.kind === 'memory' || holder.kind === 'commit' ? `host memory still short: ${holderText(holder, zone)}` : `host lock still held by ${holderText(holder, zone)}`;
}
/** The ids of `shares`, joined. */
function idsOf(shares) {
    return shares.map((share) => share.id).join(',');
}
/** Tells one report apart from the last: a new holder, a small step its holder waits for ending, or a new place in line. */
function waitKey(holder, ahead) {
    switch (holder.kind) {
        case 'held':
            return `held ${holder.info.id} ${idsOf(holder.waitsFor ?? [])} ${ahead}`;
        case 'queued':
            return `queued ${holder.first.id} ${ahead}`;
        case 'unknown':
            return `unknown ${ahead}`;
        case 'draining':
        case 'memory':
        case 'commit':
            return `${holder.kind} ${idsOf(holder.shares)} ${ahead}`;
    }
}
/** `onWait`, told only of a new holder or a new place in line. */
function tellingChanges(onWait) {
    let told;
    return (holder, ahead) => {
        const key = waitKey(holder, ahead);
        if (key !== told) {
            onWait(holder, ahead);
            told = key;
        }
    };
}
/**
 * The ids of the steps a waiter stands behind at one look: the waiters ahead, the lock's holder and the small steps
 * it waits for, the small steps sharing the host.
 */
function standingBehind(ahead, holder) {
    const ids = new Set(ahead.map((waiter) => waiter.id));
    switch (holder.kind) {
        case 'held':
            ids.add(holder.info.id);
            for (const share of holder.waitsFor ?? []) {
                ids.add(share.id);
            }
            break;
        case 'queued':
            ids.add(holder.first.id);
            break;
        case 'draining':
        case 'memory':
        case 'commit':
            for (const share of holder.shares) {
                ids.add(share.id);
            }
            break;
        case 'unknown':
            break;
    }
    return ids;
}
/**
 * When a wait runs out: `maxWaitMs` after its line last moved, so a step far back in a line that keeps moving waits on
 * while the oldest work goes first. The line moved when a step this one stood behind at its last look (a waiter ahead,
 * the lock's holder, a small step sharing the host) is gone at this one.
 */
class Patience {
    maxWaitMs;
    movedAt;
    behind = new Set();
    constructor(start, maxWaitMs) {
        this.movedAt = start;
        this.maxWaitMs = maxWaitMs;
    }
    get deadline() {
        return this.movedAt + this.maxWaitMs;
    }
    /** Takes in one look at `now`, the steps this one stands behind then; true when the line moved since the last look. */
    look(behind, now) {
        const moved = [...this.behind].some((id) => !behind.has(id));
        this.behind = behind;
        if (moved) {
            this.movedAt = now;
        }
        return moved;
    }
}
/**
 * One lock for the host's queued steps (builds, test runs, database scripts), held across the whole step. A step
 * takes it by creating the file; the file appears whole or not at all. A lock is stale once it expires or its
 * process is gone, and the next step removes it. A file that cannot be read is removed only after a waiter has
 * seen it so for `UNREADABLE_GRACE_MS`, since a writer that creates it in two steps may not have finished.
 * Waiters take it in arrival order: each joins a line of tickets in `<lock>.queue`, and only the first live one may
 * take the lock; a ticket whose process is gone or whose wait ran out is removed by the next waiter that sees it.
 * A wait runs out only once the line has not moved for its whole length (see `Patience`), so a step far back in a line
 * that keeps moving is not refused; its ticket's expiry moves on with its wait each time the line moves.
 * A step that does not join the line (an older kit, a team's own deploy tool) may still take a free lock first.
 * A session may withdraw its waiting steps (`withdraw`): each one's ticket is removed, and a step whose ticket is gone
 * stops at its next look. A step that took its turn removes its own ticket to run, so of the two removals only one
 * succeeds, and a withdrawn step never runs.
 * Small steps (`teamrig queue --small`: a spec run, a lint) share the host instead: in its turn, while the lock is not
 * held, a small step writes its share, `<lock>.shared/<id>.json`, before it leaves the line, so the next in line
 * sees it. A step that takes the lock waits, holding it, for the shares to end, so none is let in meanwhile. A share
 * whose process is gone, that expired or that cannot be read is removed by the next step that looks. A step that does
 * not know shares (an older kit) takes a free lock while they run.
 * With a memory gate in its ports, the first in line takes the lock or a share only once the gate finds the host's
 * memory has room for it, the MB held for the small steps sharing the host counted as taken; until then it waits in
 * its place, so a later step never passes a step waiting on memory, and a lone step is gated as much as one beside others.
 */
export class HostLock {
    static UNREADABLE_GRACE_MS = 10_000;
    path;
    queue;
    shared;
    ttlMs;
    ports;
    constructor(path, ttlMs, ports) {
        this.path = path;
        this.queue = `${path}.queue`;
        this.shared = `${path}.shared`;
        this.ttlMs = ttlMs;
        this.ports = ports;
    }
    /**
     * Takes the lock when it is free or stale, else names its holder. `removeUnknown`: an unreadable file is
     * removed and the lock taken, for a waiter that has seen it so long enough. It does not look at the line.
     */
    async tryTake(session, purpose, removeUnknown = false) {
        return this.take(session, purpose, removeUnknown, undefined);
    }
    /** {@link tryTake}, the lock carrying `id` when given (a waiter's ticket id), else a new one each attempt. */
    async take(session, purpose, removeUnknown, id) {
        let mayRemoveUnknown = removeUnknown;
        for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
            const lock = this.newLock(session, purpose, id ?? this.ports.newId());
            if (await this.ports.files.createExclusive(this.path, stored(lock))) {
                return { kind: 'taken', lock };
            }
            const seen = await this.read();
            if (seen.kind === 'unknown') {
                if (!mayRemoveUnknown) {
                    return { kind: 'busy', holder: { kind: 'unknown' } };
                }
                mayRemoveUnknown = false;
                await this.removeIf((text) => text === seen.text);
            }
            else if (seen.kind === 'held') {
                if (!this.isStale(seen.info)) {
                    return { kind: 'busy', holder: await this.heldBy(seen.info) };
                }
                await this.removeIf((text) => parseLock(text)?.id === seen.info.id);
            }
        }
        const last = await this.read();
        return { kind: 'busy', holder: last.kind === 'held' ? await this.heldBy(last.info) : { kind: 'unknown' } };
    }
    /**
     * The holder `info` names, with the small steps sharing the host, which a holder that names its teamrig waits to end
     * before its step runs (`drain`); one without a `kit` (an older teamrig or a team's own deploy tool) runs beside them.
     */
    async heldBy(info) {
        if (info.kit === undefined) {
            return { kind: 'held', info };
        }
        const waitsFor = await this.shares();
        return waitsFor.length === 0 ? { kind: 'held', info } : { kind: 'held', info, waitsFor };
    }
    /**
     * Takes the lock in its turn: joins the line, then looks again every `pollMs` (the first in line every
     * `FIRST_IN_LINE_POLL_MS` at most) until its line has not moved for `maxWaitMs`, and leaves the line when done.
     * `onWait` hears each new holder or place in line once, with the number of waiters ahead. A lock taken then waits,
     * held, for the small steps sharing the host to end. With a `need` that shares, a small step shares the host in its
     * turn instead (see the class); its reserve is the MB the memory gate needs for it. Busy when the wait ran out;
     * withdrawn when its ticket was withdrawn before it took its turn. Once `stop` aborts, the wait rejects with its
     * reason before its next look, as `fetch` does, leaving the line and releasing a lock it held while the small steps
     * ended, so a step no one waits for any more never takes the lock.
     */
    async acquire(session, purpose, maxWaitMs, pollMs, onWait, need, stop) {
        const patience = new Patience(this.ports.clock.now(), maxWaitMs);
        const ticket = await this.joinLine(session, purpose, patience.deadline);
        const tell = tellingChanges(onWait);
        try {
            const waited = await this.waitInLine(ticket, patience, pollMs, tell, need, stop);
            const result = waited.kind === 'taken' && waited.sharing === undefined ? await this.drain(waited.lock, ticket, patience, tell, stop) : waited;
            return result.kind === 'taken' ? await this.commit(result, ticket) : result;
        }
        finally {
            await this.ports.files.remove(join(this.queue, ticket.name));
        }
    }
    /** Releases a lock or share this step took; false when it is no longer the holder (it expired and another step took it). */
    async release(lock) {
        if (await this.removeIf((text) => parseLock(text)?.id === lock.id)) {
            return true;
        }
        const share = await this.shareWith(lock.id);
        if (share === undefined) {
            return false;
        }
        await this.ports.files.remove(share.path);
        return true;
    }
    /** The lock or share while the taking with `id` holds it and it is not stale; undefined otherwise. Takes and removes nothing. */
    async heldWith(id) {
        const seen = await this.read();
        if (seen.kind === 'held' && seen.info.id === id) {
            return this.isStale(seen.info) ? undefined : seen.info;
        }
        const share = (await this.shareWith(id))?.share;
        return share === undefined || this.isStale(share) ? undefined : share;
    }
    /** The live waiters in line, oldest first; takes and removes nothing. */
    async line() {
        return (await this.tickets()).map(({ waiter }) => waiter);
    }
    /**
     * Withdraws the waiting steps of `session` that `chosen` picks: removes each one's ticket, so the step stops at its
     * next look and never runs. A step that took its turn first is named running, or gone from the line; an older kit's
     * step is kept, its ticket left, as removing it would only cost the step its place.
     */
    async withdraw(session, chosen) {
        const done = [];
        for (const { name, waiter } of await this.tickets()) {
            if (waiter.session !== session || !chosen(waiter)) {
                continue;
            }
            if (waiter.stopsOnWithdraw !== true) {
                done.push({ kind: 'kept', waiter });
            }
            else if (await this.removeTicket(name)) {
                done.push({ kind: 'withdrawn', waiter });
            }
            else {
                done.push({ kind: (await this.heldWith(waiter.id)) === undefined ? 'left' : 'running', waiter });
            }
        }
        return done;
    }
    /** The small steps sharing the host, oldest first, a stale share left out; takes and removes nothing. */
    async shares() {
        return (await this.shareFiles()).flatMap(({ share }) => (share === undefined || this.isStale(share) ? [] : [share])).sort(byAcquiredAt);
    }
    /** The lock's state, taking and removing nothing, for a reader that only shows it. */
    async state() {
        const seen = await this.read();
        switch (seen.kind) {
            case 'missing':
                return { kind: 'free' };
            case 'unknown':
                return { kind: 'unknown' };
            case 'held':
                return this.isStale(seen.info) ? { kind: 'stale', info: seen.info } : seen;
        }
    }
    /** Looks in line until this step takes the lock, or a share when `need` shares, in its turn, or its wait runs out; rejects once `stop` aborts. */
    async waitInLine(ticket, patience, pollMs, tell, need, stop) {
        const { clock, sleep } = this.ports;
        let unknownSince;
        for (;;) {
            stop?.throwIfAborted();
            const ahead = await this.waitersAhead(ticket.name);
            if (ahead === undefined) {
                return { kind: 'withdrawn' };
            }
            const removeUnknown = unknownSince !== undefined && clock.now() - unknownSince >= HostLock.UNREADABLE_GRACE_MS;
            const result = need?.shares === true ? await this.shareInTurn(ticket.waiter, ahead, removeUnknown, need.reserveMb) : await this.takeInTurn(ticket.waiter, ahead, removeUnknown, need?.reserveMb);
            if (result.kind === 'taken') {
                return result;
            }
            const { holder } = result;
            unknownSince = holder.kind === 'unknown' ? (unknownSince ?? clock.now()) : undefined;
            tell(holder, ahead.length);
            if (!(await this.waitOn(ticket, patience, standingBehind(ahead, holder)))) {
                return { kind: 'withdrawn' };
            }
            const left = patience.deadline - clock.now();
            if (left <= 0) {
                return result;
            }
            await sleep(Math.min(ahead.length === 0 ? Math.min(pollMs, FIRST_IN_LINE_POLL_MS) : pollMs, left));
        }
    }
    /**
     * Holds a lock just taken until the small steps sharing the host end, looking every `FIRST_IN_LINE_POLL_MS`; no new
     * one is let in meanwhile, as the lock is held. Gives up, releasing the lock, when its wait runs out (no small step
     * ended for its whole length) or the lock would expire, so it never goes stale while held, and when its ticket was
     * withdrawn meanwhile. A lock that waited is renewed, so its step gets its whole time. Once `stop` aborts it releases
     * the lock and rejects with the stop's reason.
     */
    async drain(lock, ticket, patience, tell, stop) {
        const { clock, sleep } = this.ports;
        const expiry = Date.parse(lock.expiresAt);
        let waited = false;
        for (;;) {
            if (stop?.aborted === true) {
                await this.release(lock);
                stop.throwIfAborted();
            }
            const shares = await this.liveShares();
            if (shares.length === 0) {
                return { kind: 'taken', lock: waited ? await this.renew(lock) : lock };
            }
            const holder = { kind: 'draining', shares };
            tell(holder, 0);
            if (!(await this.waitOn(ticket, patience, standingBehind([], holder)))) {
                await this.release(lock);
                return { kind: 'withdrawn' };
            }
            const left = Math.min(patience.deadline, expiry) - clock.now();
            if (left <= 0) {
                await this.release(lock);
                return { kind: 'busy', holder };
            }
            waited = true;
            await sleep(Math.min(FIRST_IN_LINE_POLL_MS, left));
            if ((await this.ports.files.read(join(this.queue, ticket.name))) === undefined) {
                await this.release(lock);
                return { kind: 'withdrawn' };
            }
        }
    }
    /**
     * A step that took its turn removes its own ticket to run: when a withdraw removed it first, the lock or share just
     * taken is released and the step is withdrawn.
     */
    async commit(taken, ticket) {
        if (await this.ports.files.remove(join(this.queue, ticket.name))) {
            return taken;
        }
        await this.release(taken.lock);
        return { kind: 'withdrawn' };
    }
    /**
     * Takes in a look that found this step behind the steps `behind`: when the line moved, its wait runs out later and
     * its ticket says so, so no waiter removes it as stale meanwhile. False when its ticket was withdrawn.
     */
    async waitOn(ticket, patience, behind) {
        return !patience.look(behind, this.ports.clock.now()) || (await this.extend(ticket, patience.deadline));
    }
    /**
     * Moves this step's ticket's expiry to `deadline` plus the grace, keeping its place. The ticket is removed and written
     * again: the removal fails when a withdraw removed it first, so a withdrawn ticket never comes back (false then).
     * Meanwhile, for a moment, the line misses it.
     */
    async extend(ticket, deadline) {
        const path = join(this.queue, ticket.name);
        if (!(await this.ports.files.remove(path))) {
            return false;
        }
        await this.ports.files.write(path, stored({ ...ticket.waiter, expiresAt: ticketExpiry(deadline) }));
        return true;
    }
    /** Removes a ticket: true when this call removed it. One being renewed (`extend`) is away for a moment, so a ticket back in line is tried once more. */
    async removeTicket(name) {
        const path = join(this.queue, name);
        const { files } = this.ports;
        return (await files.remove(path)) || ((await files.list(this.queue)).includes(name) && (await files.remove(path)));
    }
    /** The lock this step holds, its expiry moved to a whole TTL from now. */
    async renew(lock) {
        const renewed = { ...lock, expiresAt: new Date(this.ports.clock.now() + this.ttlMs).toISOString() };
        await this.ports.files.write(this.path, stored(renewed));
        return renewed;
    }
    /**
     * One look in line for a small step holding `reserveMb`. A live lock is waited on, and so is an earlier waiter. Else
     * the step shares the host, under its ticket's id, once the memory gate finds room for it beside the small steps
     * already sharing it (at once with no gate); a stale lock is left for the next step that takes the lock.
     */
    async shareInTurn(waiter, ahead, removeUnknown, reserveMb) {
        const seen = await this.read();
        if (seen.kind === 'held' && !this.isStale(seen.info)) {
            return { kind: 'busy', holder: await this.heldBy(seen.info) };
        }
        const [first] = ahead;
        if (first !== undefined) {
            return { kind: 'busy', holder: seen.kind === 'unknown' ? { kind: 'unknown' } : { kind: 'queued', first } };
        }
        if (seen.kind === 'unknown') {
            if (!removeUnknown) {
                return { kind: 'busy', holder: { kind: 'unknown' } };
            }
            await this.removeIf((text) => text === seen.text);
        }
        const others = await this.liveShares();
        const look = await this.lookAtMemory(reserveMb, others);
        if (look !== undefined && look.kind !== 'room') {
            return { kind: 'busy', holder: { ...look, shares: others } };
        }
        const share = { ...this.newLock(waiter.session, waiter.purpose, waiter.id), reserveMb };
        await this.ports.files.write(join(this.shared, `${share.id}.json`), stored(share));
        return { kind: 'taken', lock: share, sharing: look === undefined ? { others } : { freeMb: look.freeMb, others } };
    }
    /**
     * The memory gate's look for a step holding `reserveMb` (the gate's `heavyReserveMb` when undefined) beside the small
     * steps `shares`, whose held MB counts as taken; undefined for a lock with no gate.
     */
    async lookAtMemory(reserveMb, shares) {
        const { memory } = this.ports;
        if (memory === undefined) {
            return undefined;
        }
        const heldMb = shares.reduce((total, share) => total + share.reserveMb, 0);
        return memory.look(reserveMb ?? memory.config.heavyReserveMb, heldMb);
    }
    /** Every share file, with what it says: undefined when it cannot be read as a share. */
    async shareFiles() {
        const { files } = this.ports;
        const found = [];
        for (const name of (await files.list(this.shared)).filter((entry) => SHARE_NAME.test(entry))) {
            const path = join(this.shared, name);
            const text = await files.read(path);
            if (text !== undefined) {
                found.push({ path, share: parseAs(text, isHostShare) });
            }
        }
        return found;
    }
    /** The live shares, oldest first; a share whose process is gone, that expired or that cannot be read is removed (shares are written whole). */
    async liveShares() {
        const live = [];
        for (const { path, share } of await this.shareFiles()) {
            if (share === undefined || this.isStale(share)) {
                await this.ports.files.remove(path);
            }
            else {
                live.push(share);
            }
        }
        return live.sort(byAcquiredAt);
    }
    /** The share the taking with `id` wrote, and its file; undefined when there is none or the id is no file name. */
    async shareWith(id) {
        const name = `${id}.json`;
        if (!SHARE_NAME.test(name)) {
            return undefined;
        }
        const path = join(this.shared, name);
        const text = await this.ports.files.read(path);
        const share = text === undefined ? undefined : parseAs(text, isHostShare);
        return share?.id === id ? { path, share } : undefined;
    }
    /**
     * One look in line for a step holding `reserveMb` (the gate's heavy reserve when undefined). A live holder is named
     * without a write, and a later waiter names the waiter first in line, which the lock goes to next. The first in line
     * takes the lock once the memory gate finds room for it, under its ticket's id so the step keeps one identity from
     * joining the line to releasing the lock; the small steps still sharing the host count as holding their MB, as the
     * step that took the lock waits for them to end.
     */
    async takeInTurn(waiter, ahead, removeUnknown, reserveMb) {
        const seen = await this.read();
        if (seen.kind === 'held' && !this.isStale(seen.info)) {
            return { kind: 'busy', holder: await this.heldBy(seen.info) };
        }
        const [first] = ahead;
        if (first !== undefined) {
            return { kind: 'busy', holder: seen.kind === 'unknown' ? { kind: 'unknown' } : { kind: 'queued', first } };
        }
        if (seen.kind === 'unknown' && !removeUnknown) {
            return { kind: 'busy', holder: { kind: 'unknown' } };
        }
        const shares = await this.liveShares();
        const look = await this.lookAtMemory(reserveMb, shares);
        if (look !== undefined && look.kind !== 'room') {
            return { kind: 'busy', holder: { ...look, shares } };
        }
        return this.take(waiter.session, waiter.purpose, removeUnknown, waiter.id);
    }
    /** Writes this step's ticket at the end of the line, its wait running out at `deadline`. */
    async joinLine(session, purpose, deadline) {
        const now = this.ports.clock.now();
        const waiter = {
            id: this.ports.newId(),
            pid: this.ports.pid,
            session,
            purpose,
            kit: KIT_VERSION,
            arrivedAt: new Date(now).toISOString(),
            expiresAt: ticketExpiry(deadline),
            stopsOnWithdraw: true,
        };
        const name = `${String(now).padStart(ARRIVAL_DIGITS, '0')}-${waiter.id}.json`;
        await this.ports.files.write(join(this.queue, name), stored(waiter));
        return { name, waiter };
    }
    /**
     * The live waiters whose tickets come before `ticket`, oldest first; undefined once `ticket` is gone, withdrawn. A
     * ticket whose process is gone, whose wait ran out or that cannot be read is removed (tickets are written whole); one
     * gone meanwhile left the line.
     */
    async waitersAhead(ticket) {
        const { files } = this.ports;
        const names = await files.list(this.queue);
        if (!names.includes(ticket)) {
            return undefined;
        }
        const earlier = names.filter((name) => TICKET_NAME.test(name) && name < ticket).sort();
        const ahead = [];
        for (const name of earlier) {
            const path = join(this.queue, name);
            const text = await files.read(path);
            if (text === undefined) {
                continue;
            }
            const waiter = parseAs(text, isLockWaiter);
            if (waiter === undefined || this.isStale(waiter)) {
                await files.remove(path);
            }
            else {
                ahead.push(waiter);
            }
        }
        return ahead;
    }
    /** The live tickets in line, oldest first, with their names; a stale or unreadable one is left out, and left. */
    async tickets() {
        const { files } = this.ports;
        const found = [];
        for (const name of (await files.list(this.queue)).filter((entry) => TICKET_NAME.test(entry)).sort()) {
            const text = await files.read(join(this.queue, name));
            const waiter = text === undefined ? undefined : parseAs(text, isLockWaiter);
            if (waiter !== undefined && !this.isStale(waiter)) {
                found.push({ name, waiter });
            }
        }
        return found;
    }
    isStale(entry) {
        return Date.parse(entry.expiresAt) <= this.ports.clock.now() || !this.ports.alive(entry.pid);
    }
    newLock(session, purpose, id) {
        const now = this.ports.clock.now();
        return {
            id,
            pid: this.ports.pid,
            session,
            purpose,
            kit: KIT_VERSION,
            acquiredAt: new Date(now).toISOString(),
            expiresAt: new Date(now + this.ttlMs).toISOString(),
        };
    }
    async read() {
        const text = await this.ports.files.read(this.path);
        if (text === undefined) {
            return { kind: 'missing' };
        }
        const info = parseLock(text);
        return info === undefined ? { kind: 'unknown', text } : { kind: 'held', info };
    }
    /** Removes the lock file while its text still passes `still`, so a lock another step took meanwhile stays. */
    async removeIf(still) {
        const text = await this.ports.files.read(this.path);
        if (text === undefined || !still(text)) {
            return false;
        }
        await this.ports.files.remove(this.path);
        return true;
    }
}
