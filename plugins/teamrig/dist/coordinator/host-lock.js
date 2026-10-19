import { join } from 'node:path';
import { isRecord } from "../core/guards.js";
import { ENV } from "../core/home.js";
import { formatUtcMinute } from "../core/time.js";
/** Tries per taking: a stale lock removed may be retaken by another step first. */
const ATTEMPTS = 3;
/**
 * How often the first in line looks, at most: it alone may take the lock, so a lock its holder released waits no
 * longer than this for the next step.
 */
export const FIRST_IN_LINE_POLL_MS = 2_000;
/** Digits of a ticket's arrival time in its name: enough for any millisecond time, so names sort as times do. */
const ARRIVAL_DIGITS = 15;
/** A ticket's name; a writer's temporary sibling (`<name>.<pid>.<n>.tmp`) does not match. */
const TICKET_NAME = /^\d{15}-[^/\\]+\.json$/;
function isTime(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
function isHostLockInfo(value) {
    return (isRecord(value) &&
        typeof value['token'] === 'string' &&
        typeof value['pid'] === 'number' &&
        typeof value['session'] === 'string' &&
        typeof value['purpose'] === 'string' &&
        isTime(value['acquiredAt']) &&
        isTime(value['expiresAt']));
}
function isLockWaiter(value) {
    return (isRecord(value) &&
        typeof value['token'] === 'string' &&
        typeof value['pid'] === 'number' &&
        typeof value['session'] === 'string' &&
        typeof value['purpose'] === 'string' &&
        isTime(value['arrivedAt']) &&
        isTime(value['expiresAt']));
}
function parseAs(text, is) {
    try {
        const value = JSON.parse(text);
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
 * `env` for a process a step starts while it holds `lock`: a `teamrig heavy` that process starts (a git hook's checks
 * under a commit or a push) runs at once under the same lock, since waiting for it would wait on its own parent.
 */
export function underLock(env, lock) {
    return { ...env, [ENV.hostLock]: lock.token };
}
/** What a waiter waits on as a session reads it: `<session> (<purpose>) since <UTC minute>` for a holder. */
export function holderText(holder) {
    switch (holder.kind) {
        case 'held':
            return `${holder.info.session} (${holder.info.purpose}) since ${formatUtcMinute(new Date(holder.info.acquiredAt))}`;
        case 'queued':
            return `${holder.first.session} (${holder.first.purpose}), first in line since ${formatUtcMinute(new Date(holder.first.arrivedAt))}`;
        case 'unknown':
            return 'a writer that has not finished writing';
    }
}
/** A waiter's report: what it waits on, then how many waiters are ahead of it in line when any are. */
export function waitText(holder, ahead) {
    return ahead === 0 ? holderText(holder) : `${holderText(holder)}; ${ahead} ahead in line`;
}
/** Tells one report apart from the last: a new holder, or a new place in line. */
function waitKey(holder, ahead) {
    switch (holder.kind) {
        case 'held':
            return `held ${holder.info.token} ${ahead}`;
        case 'queued':
            return `queued ${holder.first.token} ${ahead}`;
        case 'unknown':
            return `unknown ${ahead}`;
    }
}
/**
 * One lock for the host's heavy steps (builds, test runs, database scripts), held across the whole step. A step
 * takes it by creating the file; the file appears whole or not at all. A lock is stale once it expires or its
 * process is gone, and the next step removes it. A file that cannot be read is removed only after a waiter has
 * seen it so for `UNREADABLE_GRACE_MS`, since a writer that creates it in two steps may not have finished.
 * Waiters take it in arrival order: each joins a line of tickets in `<lock>.queue`, and only the first live one may
 * take the lock; a ticket whose process is gone or whose wait ran out is removed by the next waiter that sees it.
 * A step that does not join the line (an older kit, a team's own coordinator) may still take a free lock first.
 */
export class HostLock {
    static UNREADABLE_GRACE_MS = 10_000;
    path;
    queue;
    ttlMs;
    ports;
    constructor(path, ttlMs, ports) {
        this.path = path;
        this.queue = `${path}.queue`;
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
    /** {@link tryTake}, the lock carrying `token` when given (a waiter's ticket token), else a new one each attempt. */
    async take(session, purpose, removeUnknown, token) {
        let mayRemoveUnknown = removeUnknown;
        for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
            const lock = this.newLock(session, purpose, token ?? this.ports.newId());
            if (await this.ports.files.createExclusive(this.path, JSON.stringify(lock))) {
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
                    return { kind: 'busy', holder: seen };
                }
                await this.removeIf((text) => parseLock(text)?.token === seen.info.token);
            }
        }
        const last = await this.read();
        return { kind: 'busy', holder: last.kind === 'held' ? last : { kind: 'unknown' } };
    }
    /**
     * Takes the lock in its turn: joins the line, then looks again every `pollMs` (the first in line every
     * `FIRST_IN_LINE_POLL_MS` at most) for at most `maxWaitMs`, and leaves the line when done. `onWait` hears each new
     * holder or place in line once, with the number of waiters ahead. Busy when the wait ran out.
     */
    async acquire(session, purpose, maxWaitMs, pollMs, onWait) {
        const { clock, sleep } = this.ports;
        const deadline = clock.now() + maxWaitMs;
        const ticket = await this.joinLine(session, purpose, deadline);
        try {
            let told;
            let unknownSince;
            for (;;) {
                const ahead = await this.waitersAhead(ticket.name);
                const removeUnknown = unknownSince !== undefined && clock.now() - unknownSince >= HostLock.UNREADABLE_GRACE_MS;
                const result = await this.takeInTurn(ticket.waiter, ahead, removeUnknown);
                if (result.kind === 'taken') {
                    return result;
                }
                const { holder } = result;
                unknownSince = holder.kind === 'unknown' ? (unknownSince ?? clock.now()) : undefined;
                const key = waitKey(holder, ahead.length);
                if (key !== told) {
                    onWait(holder, ahead.length);
                    told = key;
                }
                const left = deadline - clock.now();
                if (left <= 0) {
                    return result;
                }
                await sleep(Math.min(ahead.length === 0 ? Math.min(pollMs, FIRST_IN_LINE_POLL_MS) : pollMs, left));
            }
        }
        finally {
            await this.ports.files.remove(join(this.queue, ticket.name));
        }
    }
    /** Releases a lock this step took; false when it is no longer the holder (it expired and another step took it). */
    async release(lock) {
        return this.removeIf((text) => parseLock(text)?.token === lock.token);
    }
    /** The lock while the taking with `token` holds it and it is not stale; undefined otherwise. Takes and removes nothing. */
    async heldWith(token) {
        const seen = await this.read();
        return seen.kind === 'held' && seen.info.token === token && !this.isStale(seen.info) ? seen.info : undefined;
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
    /**
     * One look in line. A live holder is named without a write. Else the first in line tries to take the lock, under
     * its ticket's token so the step keeps one identity from joining the line to releasing the lock, and a later
     * waiter names the waiter first in line, which the lock goes to next.
     */
    async takeInTurn(waiter, ahead, removeUnknown) {
        const seen = await this.read();
        if (seen.kind === 'held' && !this.isStale(seen.info)) {
            return { kind: 'busy', holder: seen };
        }
        const [first] = ahead;
        if (first === undefined) {
            return this.take(waiter.session, waiter.purpose, removeUnknown, waiter.token);
        }
        return { kind: 'busy', holder: seen.kind === 'unknown' ? { kind: 'unknown' } : { kind: 'queued', first } };
    }
    /** Writes this step's ticket at the end of the line, its wait running out at `deadline`. */
    async joinLine(session, purpose, deadline) {
        const now = this.ports.clock.now();
        const waiter = {
            token: this.ports.newId(),
            pid: this.ports.pid,
            session,
            purpose,
            arrivedAt: new Date(now).toISOString(),
            expiresAt: new Date(deadline).toISOString(),
        };
        const name = `${String(now).padStart(ARRIVAL_DIGITS, '0')}-${waiter.token}.json`;
        await this.ports.files.write(join(this.queue, name), JSON.stringify(waiter));
        return { name, waiter };
    }
    /**
     * The live waiters whose tickets come before `ticket`, oldest first. A ticket whose process is gone, whose wait ran
     * out or that cannot be read is removed (tickets are written whole); one gone meanwhile left the line.
     */
    async waitersAhead(ticket) {
        const { files } = this.ports;
        const earlier = (await files.list(this.queue)).filter((name) => TICKET_NAME.test(name) && name < ticket).sort();
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
    isStale(entry) {
        return Date.parse(entry.expiresAt) <= this.ports.clock.now() || !this.ports.alive(entry.pid);
    }
    newLock(session, purpose, token) {
        const now = this.ports.clock.now();
        return {
            token,
            pid: this.ports.pid,
            session,
            purpose,
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
