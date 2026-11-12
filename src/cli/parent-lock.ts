import { ENV } from '../core/home.ts';
import type { HostLock, HostLockInfo } from '../delivery/host-lock.ts';
import type { Say } from './delivery-ports.ts';
import type { CliRuntime } from './runtime.ts';

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
