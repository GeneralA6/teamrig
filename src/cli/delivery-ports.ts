import { resolveReset } from '../budget/pace.ts';
import { weekUseAt } from '../budget/snapshot.ts';
import { readFolderWeek } from '../budget/week-summary.ts';
import type { BudgetConfig, QueueConfig } from '../config/types.ts';
import { CLAIMS_LOCK_TTL_MS } from '../delivery/freeze-store.ts';
import { HostLock } from '../delivery/host-lock.ts';
import type { ResetTime } from '../delivery/schedule.ts';
import type { TimeZone } from '../core/zone.ts';
import type { CliRuntime } from './runtime.ts';

const MINUTE_MS = 60_000;

/** Takes a progress line. */
export type Say = (text: string) => void;

/**
 * Progress lines, each stamped with the time on the team's clock to the second (`2030-01-08 12:00:05 IST running: …`),
 * since a coordinator command mostly runs in the background with its output in a log.
 */
export function logLineOf(runtime: Pick<CliRuntime, 'out' | 'clock'>, zone: TimeZone): Say {
  return (text) => runtime.out.stdout(`${zone.second(new Date(runtime.clock.now()))} ${text}`);
}

type LockRuntime = Pick<CliRuntime, 'files' | 'clock' | 'sleep' | 'pid' | 'sessionProcesses' | 'newId'>;

/** The host lock at `path`, held by this process for `delivery.queue.lockTtlMinutes`; a holder whose process ended is stale. */
export function hostLockOf(runtime: LockRuntime, path: string, heavy: Pick<QueueConfig, 'lockTtlMinutes'>): HostLock {
  return lockAt(runtime, path, heavy.lockTtlMinutes * MINUTE_MS);
}

/** The lock the deploy freezes' writers share at `path`, held for a minute, since a write takes moments. */
export function claimsLockOf(runtime: LockRuntime, path: string): HostLock {
  return lockAt(runtime, path, CLAIMS_LOCK_TTL_MS);
}

function lockAt(runtime: LockRuntime, path: string, ttlMs: number): HostLock {
  return new HostLock(path, ttlMs, {
    files: runtime.files,
    clock: runtime.clock,
    sleep: runtime.sleep,
    pid: runtime.pid,
    alive: (pid) => runtime.sessionProcesses.alive(pid),
    newId: () => runtime.newId(),
  });
}

/** The next weekly token reset at each check: the one the status line last reported, else the one `budget.reset` sets; undefined when neither says. */
export function nextResetFrom(runtime: Pick<CliRuntime, 'files'>, budget: Pick<BudgetConfig, 'reset'>, snapshotDir: string): (nowMs: number) => Promise<ResetTime | undefined> {
  return async (nowMs) => {
    const fromStatus = weekUseAt(await readFolderWeek(runtime.files, snapshotDir, nowMs), nowMs)?.resetsAt;
    const at = resolveReset(nowMs, fromStatus, budget.reset);
    if (at === undefined) {
      return undefined;
    }
    return { at, source: at === fromStatus ? 'status line' : 'budget.reset config' };
  };
}
