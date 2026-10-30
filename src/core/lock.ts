import type { Files } from './files.ts';
import { isRecord } from './guards.ts';

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LockTimings {
  /** A lock older than this is presumed abandoned by a crashed holder and is taken over. */
  readonly ttlMs: number;
  /** How often a waiter retries. */
  readonly pollMs: number;
  /** How long a waiter tries before giving up with LockBusyError. */
  readonly waitMs: number;
}

/** Runs a task while holding exclusive access. */
export interface Mutex {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export class LockBusyError extends Error {
  constructor(path: string, waitMs: number) {
    super(`${path} is held by another process (waited ${waitMs} ms); retry`);
    this.name = 'LockBusyError';
  }
}

export interface FileLockDeps {
  readonly files: Files;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly pid: number;
  /** A new id, unique to each taking of a lock. */
  newId(): string;
}

/** What a lock file holds: who took it, when, and the id of that taking (absent in a lock an older kit took). */
interface Holder {
  readonly pid: number | undefined;
  readonly at: number;
  readonly id: string | undefined;
}

/**
 * A cross-process lock: an exclusively created file holding `{pid, at, id}`, the id new at each taking. A holder
 * that crashed leaves the file behind, so a lock older than `ttlMs` is removed and retried. Tasks must finish
 * well inside `ttlMs`; the kit's own writes take milliseconds. A holder releases the lock only while it still
 * holds its own taking, so a lock another process took over meanwhile stays.
 */
export class FileLock implements Mutex {
  private readonly path: string;
  private readonly timings: LockTimings;
  private readonly deps: FileLockDeps;

  constructor(path: string, timings: LockTimings, deps: FileLockDeps) {
    this.path = path;
    this.timings = timings;
    this.deps = deps;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const id = await this.acquire();
    try {
      return await task();
    } finally {
      await this.release(id);
    }
  }

  /** Takes the lock, waiting while another holds it; the id of this taking. */
  private async acquire(): Promise<string> {
    const { files, clock, sleep, pid } = this.deps;
    const id = this.deps.newId();
    const deadline = clock.now() + this.timings.waitMs;
    for (;;) {
      if (await files.createExclusive(this.path, JSON.stringify({ pid, at: clock.now(), id }))) {
        return id;
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

  /** Removes the lock while it is still the taking `id`; a lock another process took meanwhile stays. */
  private async release(id: string): Promise<void> {
    const text = await this.deps.files.read(this.path);
    if (text !== undefined && holderOf(text)?.id === id) {
      await this.deps.files.remove(this.path);
    }
  }

  /** A lock that is unreadable or older than the TTL no longer protects anyone; a vanished one is simply retried. */
  private isStale(text: string | undefined, now: number): boolean {
    if (text === undefined) {
      return false;
    }
    const holder = holderOf(text);
    return holder === undefined || now - holder.at > this.timings.ttlMs;
  }
}

/** The holder a lock file names; undefined when it cannot be read or names no time. */
function holderOf(text: string): Holder | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
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
