import type { HostLock, HostLockInfo } from '../delivery/host-lock.ts';

/** A lock whose line the step was withdrawn from while it waited, keeping each lock it is asked to release in `released`. */
export function withdrawnLock(released: HostLockInfo[]): Pick<HostLock, 'acquire' | 'release'> {
  return {
    acquire: async () => ({ kind: 'withdrawn' }),
    release: async (lock) => {
      released.push(lock);
      return true;
    },
  };
}
