import { isRecord } from '../core/guards.ts';
import type { Files } from '../core/files.ts';
import { ENV, type Env } from '../core/home.ts';
import type { Clock, Sleep } from '../core/lock.ts';
import { formatUtcMinute } from '../core/time.ts';

/**
 * The host lock's file. Its fields are the ones a team's own coordinator writes too, so both take the same
 * lock while a team moves its callers to teamrig; a field either adds is ignored.
 */
export interface HostLockInfo {
  /** Unique to one taking: only the step that took the lock releases it. */
  readonly token: string;
  /** The process holding it; once that process is gone, the lock is stale. */
  readonly pid: number;
  readonly session: string;
  readonly purpose: string;
  /** An ISO time. */
  readonly acquiredAt: string;
  /** An ISO time; from it on, the lock is stale. */
  readonly expiresAt: string;
}

/** Who holds the lock: a step, or no one that can be named (a file still being written, or a damaged one). */
export type LockHolder = { readonly kind: 'held'; readonly info: HostLockInfo } | { readonly kind: 'unknown' };

export type Taking = { readonly kind: 'taken'; readonly lock: HostLockInfo } | { readonly kind: 'busy'; readonly holder: LockHolder };

/** The lock as a reader sees it: free, held, stale (expired or its process gone; the next step removes it) or being written. */
export type LockState = { readonly kind: 'free' } | { readonly kind: 'stale'; readonly info: HostLockInfo } | LockHolder;

export interface HostLockPorts {
  readonly files: Files;
  readonly clock: Clock;
  readonly sleep: Sleep;
  /** This process: the lock names it as the holder. */
  readonly pid: number;
  /** Whether a process still runs. */
  alive(pid: number): boolean;
  /** A new unique token. */
  newId(): string;
}

type Seen = { readonly kind: 'missing' } | { readonly kind: 'unknown'; readonly text: string } | { readonly kind: 'held'; readonly info: HostLockInfo };

/** Tries per taking: a stale lock removed may be retaken by another step first. */
const ATTEMPTS = 3;

function isHostLockInfo(value: unknown): value is HostLockInfo {
  return (
    isRecord(value) &&
    typeof value['token'] === 'string' &&
    typeof value['pid'] === 'number' &&
    typeof value['session'] === 'string' &&
    typeof value['purpose'] === 'string' &&
    typeof value['acquiredAt'] === 'string' &&
    !Number.isNaN(Date.parse(value['acquiredAt'])) &&
    typeof value['expiresAt'] === 'string' &&
    !Number.isNaN(Date.parse(value['expiresAt']))
  );
}

function parseLock(text: string): HostLockInfo | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isHostLockInfo(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `env` for a process a step starts while it holds `lock`: a `teamrig heavy` that process starts (a git hook's checks
 * under a commit or a push) runs at once under the same lock, since waiting for it would wait on its own parent.
 */
export function underLock(env: Env, lock: HostLockInfo): Env {
  return { ...env, [ENV.hostLock]: lock.token };
}

/** The holder as a session reads it: `<session> (<purpose>) since <UTC minute>`. */
export function holderText(holder: LockHolder): string {
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
  static readonly UNREADABLE_GRACE_MS = 10_000;

  private readonly path: string;
  private readonly ttlMs: number;
  private readonly ports: HostLockPorts;

  constructor(path: string, ttlMs: number, ports: HostLockPorts) {
    this.path = path;
    this.ttlMs = ttlMs;
    this.ports = ports;
  }

  /**
   * Takes the lock when it is free or stale, else names its holder. `removeUnknown`: an unreadable file is
   * removed and the lock taken, for a waiter that has seen it so long enough.
   */
  async tryTake(session: string, purpose: string, removeUnknown: boolean = false): Promise<Taking> {
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
      } else if (seen.kind === 'held') {
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
  async acquire(session: string, purpose: string, maxWaitMs: number, pollMs: number, onWait: (holder: LockHolder) => void): Promise<Taking> {
    const { clock, sleep } = this.ports;
    const deadline = clock.now() + maxWaitMs;
    let told: string | undefined;
    let unknownSince: number | undefined;
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
  async release(lock: HostLockInfo): Promise<boolean> {
    return this.removeIf((text) => parseLock(text)?.token === lock.token);
  }

  /** The lock while the taking with `token` holds it and it is not stale; undefined otherwise. Takes and removes nothing. */
  async heldWith(token: string): Promise<HostLockInfo | undefined> {
    const seen = await this.read();
    return seen.kind === 'held' && seen.info.token === token && !this.isStale(seen.info) ? seen.info : undefined;
  }

  /** The lock's state, taking and removing nothing, for a reader that only shows it. */
  async state(): Promise<LockState> {
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

  private isStale(info: HostLockInfo): boolean {
    return Date.parse(info.expiresAt) <= this.ports.clock.now() || !this.ports.alive(info.pid);
  }

  private newLock(session: string, purpose: string): HostLockInfo {
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

  private async read(): Promise<Seen> {
    const text = await this.ports.files.read(this.path);
    if (text === undefined) {
      return { kind: 'missing' };
    }
    const info = parseLock(text);
    return info === undefined ? { kind: 'unknown', text } : { kind: 'held', info };
  }

  /** Removes the lock file while its text still passes `still`, so a lock another step took meanwhile stays. */
  private async removeIf(still: (text: string) => boolean): Promise<boolean> {
    const text = await this.ports.files.read(this.path);
    if (text === undefined || !still(text)) {
      return false;
    }
    await this.ports.files.remove(this.path);
    return true;
  }
}
