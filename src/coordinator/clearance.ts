import type { Clock, Sleep } from '../core/lock.ts';
import { holderText, type HostLock, type HostLockInfo } from './host-lock.ts';

/** Whether a deploy step may start: at once, never (a cutoff or blackout), or after a wait (a quiet claim). */
export type Readiness = { readonly kind: 'go' } | { readonly kind: 'refuse'; readonly reason: string } | { readonly kind: 'wait'; readonly reason: string };

/** How the wait for clearance ended: the host lock taken with nothing holding the step, refused, or out of time. */
export type Clearance =
  | { readonly kind: 'taken'; readonly lock: HostLockInfo }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'gaveUp'; readonly reason: string };

export interface ClearanceRequest {
  readonly session: string;
  /** What the lock names as its holder's purpose, such as `integrate api`. */
  readonly purpose: string;
  /** The whole wait, for claims and the lock together. */
  readonly maxWaitMs: number;
  readonly pollMs: number;
  /** Hears each new reason to wait once, so a long wait logs a line a change. */
  readonly onWait: (reason: string) => void;
}

export interface ClearancePorts {
  readonly lock: Pick<HostLock, 'acquire' | 'release'>;
  readonly clock: Clock;
  readonly sleep: Sleep;
}

/**
 * Takes the host lock once nothing holds the step back. A refusal ends the wait at once; a reason to wait and a busy
 * lock are waited out, for at most `maxWaitMs` in all. Readiness is asked again under the lock, since a claim may
 * start while the step waited for the lock: then the lock is released and the wait goes on.
 */
export async function takeWhenClear(readiness: () => Promise<Readiness>, ports: ClearancePorts, request: ClearanceRequest): Promise<Clearance> {
  const { lock, clock, sleep } = ports;
  const deadline = clock.now() + request.maxWaitMs;
  let told: string | undefined;
  /** Logs a new reason and sleeps one poll; false when the wait has run out. */
  const hold = async (reason: string): Promise<boolean> => {
    if (reason !== told) {
      request.onWait(reason);
      told = reason;
    }
    const left = deadline - clock.now();
    if (left <= 0) {
      return false;
    }
    await sleep(Math.min(request.pollMs, left));
    return true;
  };
  for (;;) {
    const before = await readiness();
    if (before.kind === 'refuse') {
      return { kind: 'refused', reason: before.reason };
    }
    if (before.kind === 'wait') {
      if (!(await hold(before.reason))) {
        return { kind: 'gaveUp', reason: before.reason };
      }
      continue;
    }
    const taking = await lock.acquire(request.session, request.purpose, Math.max(0, deadline - clock.now()), request.pollMs, (holder) =>
      request.onWait(`the host lock: ${holderText(holder)}`),
    );
    if (taking.kind === 'busy') {
      return { kind: 'gaveUp', reason: `host lock still held by ${holderText(taking.holder)}` };
    }
    const under = await readiness();
    if (under.kind === 'go') {
      return { kind: 'taken', lock: taking.lock };
    }
    await lock.release(taking.lock);
    told = undefined;
    if (under.kind === 'refuse') {
      return { kind: 'refused', reason: under.reason };
    }
    if (!(await hold(under.reason))) {
      return { kind: 'gaveUp', reason: under.reason };
    }
  }
}
