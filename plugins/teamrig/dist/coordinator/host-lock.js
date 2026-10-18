import { isRecord } from "../core/guards.js";
import { ENV } from "../core/home.js";
import { formatUtcMinute } from "../core/time.js";
/** Tries per taking: a stale lock removed may be retaken by another step first. */
const ATTEMPTS = 3;
function isHostLockInfo(value) {
    return (isRecord(value) &&
        typeof value['token'] === 'string' &&
        typeof value['pid'] === 'number' &&
        typeof value['session'] === 'string' &&
        typeof value['purpose'] === 'string' &&
        typeof value['acquiredAt'] === 'string' &&
        !Number.isNaN(Date.parse(value['acquiredAt'])) &&
        typeof value['expiresAt'] === 'string' &&
        !Number.isNaN(Date.parse(value['expiresAt'])));
}
function parseLock(text) {
    try {
        const value = JSON.parse(text);
        return isHostLockInfo(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * `env` for a process a step starts while it holds `lock`: a `teamrig heavy` that process starts (a git hook's checks
 * under a commit or a push) runs at once under the same lock, since waiting for it would wait on its own parent.
 */
export function underLock(env, lock) {
    return { ...env, [ENV.hostLock]: lock.token };
}
/** The holder as a session reads it: `<session> (<purpose>) since <UTC minute>`. */
export function holderText(holder) {
    return holder.kind === 'held'
        ? `${holder.info.session} (${holder.info.purpose}) since ${formatUtcMinute(new Date(holder.info.acquiredAt))}`
        : 'a writer that has not finished writing';
}
/**
 * One lock for the host's heavy steps (builds, test runs, database scripts), held across the whole step. A step
 * takes it by creating the file; the file appears whole or not at all. A lock is stale once it expires or its
 * process is gone, and the next step removes it. A file that cannot be read is removed only after a waiter has
 * seen it so for `UNREADABLE_GRACE_MS`, since a writer that creates it in two steps may not have finished.
 */
export class HostLock {
    static UNREADABLE_GRACE_MS = 10_000;
    path;
    ttlMs;
    ports;
    constructor(path, ttlMs, ports) {
        this.path = path;
        this.ttlMs = ttlMs;
        this.ports = ports;
    }
    /**
     * Takes the lock when it is free or stale, else names its holder. `removeUnknown`: an unreadable file is
     * removed and the lock taken, for a waiter that has seen it so long enough.
     */
    async tryTake(session, purpose, removeUnknown = false) {
        let mayRemoveUnknown = removeUnknown;
        for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
            const lock = this.newLock(session, purpose);
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
     * Takes the lock, looking again every `pollMs` for at most `maxWaitMs`; `onWait` hears each new holder once.
     * Busy when the wait ran out.
     */
    async acquire(session, purpose, maxWaitMs, pollMs, onWait) {
        const { clock, sleep } = this.ports;
        const deadline = clock.now() + maxWaitMs;
        let told;
        let unknownSince;
        for (;;) {
            const result = await this.tryTake(session, purpose, unknownSince !== undefined && clock.now() - unknownSince >= HostLock.UNREADABLE_GRACE_MS);
            if (result.kind === 'taken') {
                return result;
            }
            const { holder } = result;
            unknownSince = holder.kind === 'unknown' ? (unknownSince ?? clock.now()) : undefined;
            const key = holder.kind === 'held' ? holder.info.token : '';
            if (key !== told) {
                onWait(holder);
                told = key;
            }
            const left = deadline - clock.now();
            if (left <= 0) {
                return result;
            }
            await sleep(Math.min(pollMs, left));
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
    isStale(info) {
        return Date.parse(info.expiresAt) <= this.ports.clock.now() || !this.ports.alive(info.pid);
    }
    newLock(session, purpose) {
        const now = this.ports.clock.now();
        return {
            token: this.ports.newId(),
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
