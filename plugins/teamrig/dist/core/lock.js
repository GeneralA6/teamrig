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
 * A cross-process lock: an exclusively created file holding `{pid, at}`. A holder that crashed
 * leaves the file behind, so a lock older than `ttlMs` is removed and retried. Tasks must finish
 * well inside `ttlMs`; the kit's own writes take milliseconds.
 */
export class FileLock {
    path;
    timings;
    deps;
    constructor(path, timings, deps) {
        this.path = path;
        this.timings = timings;
        this.deps = deps;
    }
    async run(task) {
        await this.acquire();
        try {
            return await task();
        }
        finally {
            await this.deps.files.remove(this.path);
        }
    }
    async acquire() {
        const { files, clock, sleep, pid } = this.deps;
        const deadline = clock.now() + this.timings.waitMs;
        for (;;) {
            if (await files.createExclusive(this.path, JSON.stringify({ pid, at: clock.now() }))) {
                return;
            }
            if (this.isStale(await files.read(this.path), clock.now())) {
                await files.remove(this.path);
                continue;
            }
            if (clock.now() >= deadline) {
                throw new LockBusyError(this.path, this.timings.waitMs);
            }
            await sleep(this.timings.pollMs);
        }
    }
    /** A lock that is unreadable or older than the TTL no longer protects anyone; a vanished one is simply retried. */
    isStale(text, now) {
        if (text === undefined) {
            return false;
        }
        let holder;
        try {
            holder = JSON.parse(text);
        }
        catch {
            return true;
        }
        const at = isRecord(holder) ? holder['at'] : undefined;
        return typeof at !== 'number' || now - at > this.timings.ttlMs;
    }
}
