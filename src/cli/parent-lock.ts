import { ENV } from '../core/home.ts';
import type { TimeZone } from '../core/zone.ts';
import { holderText, type HostLock, type HostLockInfo } from '../delivery/host-lock.ts';
import type { Say } from './delivery-ports.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';

/**
 * The lock of the step that started this one, from `$TEAMRIG_HOST_LOCK`, while that step still holds it; undefined when
 * the variable is unset or names no live lock (a leftover in a shell), which is said, since the step then waits as usual.
 */
export async function parentLockOf(runtime: Pick<CliRuntime, 'env'>, lock: Pick<HostLock, 'heldWith'>, say: Say): Promise<HostLockInfo | undefined> {
  const token = runtime.env[ENV.hostLock]?.trim();
  if (token === undefined || token === '') {
    return undefined;
  }
  const held = await lock.heldWith(token);
  if (held === undefined) {
    say(`$${ENV.hostLock} names no live host lock: taking the lock as usual`);
  }
  return held;
}

/**
 * Refuses a command that takes the whole host lock itself (`merge`, `deploy`) when a live queued step started it
 * (T2434): it would wait for every step sharing the host to end, its own parent too, while the parent waits for it, so
 * neither moves until the queue kills the parent at its time limit. Such a command queues itself, so it runs unwrapped.
 */
export async function refuseUnderParentLock(runtime: Pick<CliRuntime, 'env'>, lock: Pick<HostLock, 'heldWith'>, say: Say, zone: TimeZone, command: string): Promise<void> {
  const parent = await parentLockOf(runtime, lock, say);
  if (parent !== undefined) {
    const holder = holderText({ kind: 'held', info: parent }, zone);
    throw new RefusedError(
      `${command} takes the whole host lock itself, so under the queued step of ${holder} it would wait for that step to end while ` +
        `the step waits for it: run ${command} without teamrig queue, as it waits in the host lock's line on its own`,
    );
  }
}
