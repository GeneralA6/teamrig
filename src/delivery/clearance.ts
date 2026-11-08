import type { Clock, Sleep } from '../core/lock.ts';
import type { TimeZone } from '../core/zone.ts';
import { busyText, waitText, type HostLock, type HostLockInfo } from './host-lock.ts';

/** Whether a deploy step may start: at once, never (a cutoff or blackout), or after a wait (a deploy freeze). */
export type Readiness = { readonly kind: 'go' } | { readonly kind: 'refuse'; readonly reason: string } | { readonly kind: 'wait'; readonly reason: string };

/** When readiness is asked: before the host lock is taken, or under it, the answer the step goes on. */
export type ClearancePhase = 'before' | 'locked';

/** How the wait for clearance ended: the host lock taken with nothing holding the step, refused, or out of time. */
export type Clearance =
  | { readonly kind: 'taken'; readonly lock: HostLockInfo }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'gaveUp'; readonly reason: string };

export interface ClearanceRequest {
  readonly session: string;
  /** What the lock names as its holder's purpose, such as `merge api`. */
  readonly purpose: string;
  /** The whole wait, for freezes and the lock together; the lock's goes on past it while its line moves. */
  readonly maxWaitMs: number;
  readonly pollMs: number;
  /** Hears each new reason to wait once, so a long wait logs a line a change. */
  readonly onWait: (reason: string) => void;
  /** The team's clock, for the lock holder's time in a wait line. */
  readonly zone: TimeZone;
}

export interface ClearancePorts {
  readonly lock: Pick<HostLock, 'acquire' | 'release'>;
  readonly clock: Clock;
  readonly sleep: Sleep;
}

/**
 * Takes the host lock once nothing holds the step back. A refusal ends the wait at once; a reason to wait and a busy
 * lock are waited out, for at most `maxWaitMs` in all, the lock longer while its line moves (see `HostLock.acquire`).
 * Readiness is asked again under the lock, since a freeze may start while the step waited for the lock: then the lock
 * is released and the wait goes on. Each ask names its phase, so a check that costs or changes something can run
 * only under the lock.
 */
export async function takeWhenClear(readiness: (phase: ClearancePhase) => Promise<Readiness>, ports: ClearancePorts, request: ClearanceRequest): Promise<Clearance> {
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
    const before = await readiness('before');
    if (before.kind === 'refuse') {
      return { kind: 'refused', reason: before.reason };
    }
    if (before.kind === 'wait') {
      if (!(await hold(before.reason))) {
        return { kind: 'gaveUp', reason: before.reason };
      }
      continue;
    }
    const taking = await lock.acquire(request.session, request.purpose, Math.max(0, deadline - clock.now()), request.pollMs, (holder, ahead) =>
      request.onWait(`the host lock: ${waitText(holder, ahead, request.zone)}`),
    );
    if (taking.kind === 'busy') {
      return { kind: 'gaveUp', reason: busyText(taking.holder, request.zone) };
    }
    if (taking.kind === 'withdrawn') {
      return { kind: 'refused', reason: "withdrawn from the host lock's line (teamrig withdraw)" };
    }
    const under = await readiness('locked');
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
