import { resolveReset } from '../budget/pace.ts';
import { readSnapshots, weekUseOf } from '../budget/snapshot.ts';
import type { BudgetConfig, HeavyConfig } from '../config/types.ts';
import { CLAIMS_LOCK_TTL_MS } from '../coordinator/claim-store.ts';
import { HostLock } from '../coordinator/host-lock.ts';
import type { ResetTime } from '../coordinator/schedule.ts';
import type { CliRuntime } from './runtime.ts';

const MINUTE_MS = 60_000;

/** A progress line stamped with the time, since a coordinator command mostly runs in the background with its output in a log. */
export function logLine(runtime: Pick<CliRuntime, 'out' | 'clock'>, text: string): void {
  runtime.out.stdout(`${new Date(runtime.clock.now()).toISOString()} ${text}`);
}

type LockRuntime = Pick<CliRuntime, 'files' | 'clock' | 'sleep' | 'pid' | 'sessionProcesses' | 'newId'>;

/** The host lock at `path`, held by this process for `coordinator.heavy.lockTtlMinutes`; a holder whose process ended is stale. */
export function hostLockOf(runtime: LockRuntime, path: string, heavy: Pick<HeavyConfig, 'lockTtlMinutes'>): HostLock {
  return lockAt(runtime, path, heavy.lockTtlMinutes * MINUTE_MS);
}

/** The lock the quiet claims' writers share at `path`, held for a minute, since a write takes moments. */
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
    const fromStatus = weekUseOf(await readSnapshots(runtime.files, snapshotDir), nowMs)?.resetsAt;
    const at = resolveReset(nowMs, fromStatus, budget.reset);
    if (at === undefined) {
      return undefined;
    }
    return { at, source: at === fromStatus ? 'status line' : 'budget.reset config' };
  };
}
