import { isRecord } from "./guards.js";
export const systemClock = { now: () => Date.now() };
export const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class LockBusyError extends Error {
    constructor(path, waitMs) {
        super(`${path} is held by another process (waited ${waitMs} ms); retry`);
        this.name = 'LockBusyError';
    }
}
/**
 * A cross-process lock: an exclusively created file holding `{pid, at, id}`, the id new at each taking; the file
 * appears whole or not at all (`Files.createExclusive`). A lock is stale once its process is gone, it is older than
 * `ttlMs` or it cannot be read, and a waiter then takes it over; a live holder is waited for. Waiters take over one at
 * a time, each while it holds `<lock>.takeover`, and remove the lock only while it still reads as the one they
 * judged, so a lock another waiter took meanwhile stays. A holder releases the lock only while it still holds its own
 * taking. A takeover guard is stale as a lock is; it is held for milliseconds, so one is stale only when its waiter
 * died mid-takeover.
 */
export class FileLock {
    path;
    guard;
    timings;
    deps;
    constructor(path, timings, deps) {
        this.path = path;
        this.guard = `${path}.takeover`;
        this.timings = timings;
        this.deps = deps;
    }
    async run(task) {
        const id = await this.acquire();
        try {
            return await task();
        }
        finally {
            await this.removeIf(this.path, (text) => holderOf(text)?.id === id);
        }
    }
    /** Takes the lock, waiting while another holds it; the id of this taking. */
    async acquire() {
        const { files, clock, sleep } = this.deps;
        const id = this.deps.newId();
        const deadline = clock.now() + this.timings.waitMs;
        for (;;) {
            if (await this.create(this.path, id)) {
                return id;
            }
            const seen = await files.read(this.path);
            if (seen !== undefined && this.isStale(seen) && (await this.takeOver(seen, id))) {
                continue;
            }
            if (clock.now() >= deadline) {
                throw new LockBusyError(this.path, this.timings.waitMs);
            }
            await sleep(this.timings.pollMs);
        }
    }
    /**
     * Removes the stale lock `seen` while this waiter holds the takeover guard, and only while the lock still reads
     * `seen`. False when another waiter holds the guard; a stale guard is cleared for the next try.
     */
    async takeOver(seen, id) {
        if (!(await this.create(this.guard, id))) {
            const held = await this.deps.files.read(this.guard);
            if (held !== undefined && this.isStale(held)) {
                await this.removeIf(this.guard, (text) => text === held);
            }
            return false;
        }
        try {
            await this.removeIf(this.path, (text) => text === seen);
            return true;
        }
        finally {
            await this.removeIf(this.guard, (text) => holderOf(text)?.id === id);
        }
    }
    /** Creates the file `path` naming this process and the taking `id`; false when it exists. */
    async create(path, id) {
        const { files, clock, pid } = this.deps;
        return files.createExclusive(path, JSON.stringify({ pid, at: clock.now(), id }));
    }
    /** Removes the file `path` while its text still passes `still`, so a file another process wrote meanwhile stays. */
    async removeIf(path, still) {
        const text = await this.deps.files.read(path);
        if (text !== undefined && still(text)) {
            await this.deps.files.remove(path);
        }
    }
    /**
     * A lock no longer protects anyone once its process is gone, it is older than `ttlMs` (its pid may be another
     * process's by now) or it cannot be read (it appears whole, so it was damaged).
     */
    isStale(text) {
        const holder = holderOf(text);
        if (holder === undefined) {
            return true;
        }
        const gone = holder.pid !== undefined && !this.deps.alive(holder.pid);
        return gone || this.deps.clock.now() - holder.at > this.timings.ttlMs;
    }
}
/** The holder a lock file names; undefined when it cannot be read or names no time. */
function holderOf(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!isRecord(parsed)) {
        return undefined;
    }
    const { pid, at, id } = parsed;
    if (typeof at !== 'number') {
        return undefined;
    }
    return { pid: typeof pid === 'number' ? pid : undefined, at, id: typeof id === 'string' ? id : undefined };
}
