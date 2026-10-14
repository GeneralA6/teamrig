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
}

/**
 * A cross-process lock: an exclusively created file holding `{pid, at}`. A holder that crashed
 * leaves the file behind, so a lock older than `ttlMs` is removed and retried. Tasks must finish
 * well inside `ttlMs`; the kit's own writes take milliseconds.
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
    await this.acquire();
    try {
      return await task();
    } finally {
      await this.deps.files.remove(this.path);
    }
  }

  private async acquire(): Promise<void> {
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
  private isStale(text: string | undefined, now: number): boolean {
    if (text === undefined) {
      return false;
    }
    let holder: unknown;
    try {
      holder = JSON.parse(text);
    } catch {
      return true;
    }
    const at = isRecord(holder) ? holder['at'] : undefined;
    return typeof at !== 'number' || now - at > this.timings.ttlMs;
  }
}
