import type { Clock } from '../core/lock.ts';
import type { LockWait } from './host-lock.ts';

/**
 * Why a queued step waited, as its start record sums it: the host lock held by another step (`lock`), an earlier waiter
 * the free lock goes to first (`line`), the small steps sharing the host ending before a heavy step runs (`draining`),
 * the host's free memory or commit charge too short (`memory`, `commit`), a deploy freeze (`freeze`) or a deploy check
 * holding the step (`check`).
 */
export const WAIT_CAUSES = ['lock', 'line', 'draining', 'memory', 'commit', 'freeze', 'check'] as const;

export type WaitCause = (typeof WAIT_CAUSES)[number];

/** The ms a step waited on each cause; a cause it never waited on is left out. */
export type WaitTotals = Partial<Readonly<Record<WaitCause, number>>>;

/** One new reason to wait, as a waiting step hears it: its cause, and the line a session reads. */
export interface WaitTold {
  readonly cause: WaitCause;
  readonly text: string;
}

/** The cause of a wait on the host lock; a lock file still being written (`unknown`) counts as held. */
export function causeOfLockWait(wait: LockWait): WaitCause {
  switch (wait.kind) {
    case 'held':
    case 'unknown':
      return 'lock';
    case 'queued':
      return 'line';
    case 'draining':
    case 'memory':
    case 'commit':
      return wait.kind;
  }
}

/** An `onWait` that logs each reason in `waits` and says it as `waiting: <text>`. */
export function sayingWaits(waits: WaitLog, say: (line: string) => void): (told: WaitTold) => void {
  return (told) => {
    waits.tell(told);
    say(`waiting: ${told.text}`);
  };
}

/** A step's whole wait: when it began, the ms it waited by cause, and the host's free memory then, when it was read. */
export interface Waited {
  readonly queuedAt: number;
  readonly waits: WaitTotals;
  readonly queueFreeMb?: number;
}

/**
 * Sums one step's wait by cause, from when the step began to wait (the log's making). A reason told counts until the
 * next one is told or the wait ends, so the time before the first reason, when the step had none, counts under no cause.
 */
export class WaitLog {
  private readonly clock: Pick<Clock, 'now'>;
  private readonly queuedAt: number;
  private readonly queueFreeMb: number | undefined;
  private readonly totals: Partial<Record<WaitCause, number>> = {};
  private lastTold: WaitTold | undefined;
  private openSince: number | undefined;

  constructor(clock: Pick<Clock, 'now'>, queueFreeMb?: number) {
    this.clock = clock;
    this.queuedAt = clock.now();
    this.queueFreeMb = queueFreeMb;
  }

  /** A new reason to wait: the open one ends now, and this one counts from now. */
  tell(told: WaitTold): void {
    const now = this.clock.now();
    this.close(now);
    this.lastTold = told;
    this.openSince = now;
  }

  /** The last reason told, kept after the wait ends; undefined when the step never waited. */
  last(): WaitTold | undefined {
    return this.lastTold;
  }

  /** Ends the wait: the open reason ends now, and the causes that took no time are left out. */
  end(): Waited {
    this.close(this.clock.now());
    const waits: Partial<Record<WaitCause, number>> = {};
    for (const cause of WAIT_CAUSES) {
      const ms = this.totals[cause] ?? 0;
      if (ms > 0) {
        waits[cause] = ms;
      }
    }
    return { queuedAt: this.queuedAt, waits, ...(this.queueFreeMb === undefined ? {} : { queueFreeMb: this.queueFreeMb }) };
  }

  private close(now: number): void {
    if (this.lastTold !== undefined && this.openSince !== undefined) {
      const cause = this.lastTold.cause;
      this.totals[cause] = (this.totals[cause] ?? 0) + (now - this.openSince);
    }
    this.openSince = undefined;
  }
}
