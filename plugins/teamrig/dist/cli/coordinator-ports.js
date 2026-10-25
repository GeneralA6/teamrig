import { resolveReset } from "../budget/pace.js";
import { weekUseAt } from "../budget/snapshot.js";
import { readFolderWeek } from "../budget/week-summary.js";
import { CLAIMS_LOCK_TTL_MS } from "../coordinator/claim-store.js";
import { HostLock } from "../coordinator/host-lock.js";
const MINUTE_MS = 60_000;
/**
 * Progress lines, each stamped with the time on the team's clock to the second (`2030-01-08 12:00:05 IST running: …`),
 * since a coordinator command mostly runs in the background with its output in a log.
 */
export function logLineOf(runtime, zone) {
    return (text) => runtime.out.stdout(`${zone.second(new Date(runtime.clock.now()))} ${text}`);
}
/** The host lock at `path`, held by this process for `coordinator.heavy.lockTtlMinutes`; a holder whose process ended is stale. */
export function hostLockOf(runtime, path, heavy) {
    return lockAt(runtime, path, heavy.lockTtlMinutes * MINUTE_MS);
}
/** The lock the quiet claims' writers share at `path`, held for a minute, since a write takes moments. */
export function claimsLockOf(runtime, path) {
    return lockAt(runtime, path, CLAIMS_LOCK_TTL_MS);
}
function lockAt(runtime, path, ttlMs) {
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
export function nextResetFrom(runtime, budget, snapshotDir) {
    return async (nowMs) => {
        const fromStatus = weekUseAt(await readFolderWeek(runtime.files, snapshotDir, nowMs), nowMs)?.resetsAt;
        const at = resolveReset(nowMs, fromStatus, budget.reset);
        if (at === undefined) {
            return undefined;
        }
        return { at, source: at === fromStatus ? 'status line' : 'budget.reset config' };
    };
}
