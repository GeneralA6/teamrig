import { resolveReset } from "../budget/pace.js";
import { weekUseAt } from "../budget/snapshot.js";
import { readFolderWeek } from "../budget/week-summary.js";
import { FREEZES_LOCK_TTL_MS } from "../delivery/freeze-store.js";
import { HostLock } from "../delivery/host-lock.js";
import { MemoryGate } from "../delivery/memory-gate.js";
const MINUTE_MS = 60_000;
/**
 * Progress lines, each stamped with the time on the team's clock to the second (`2030-01-08 12:00:05 IST running: …`),
 * since a delivery command mostly runs in the background with its output in a log.
 */
export function logLineOf(runtime, zone) {
    return (text) => runtime.out.stdout(`${zone.second(new Date(runtime.clock.now()))} ${text}`);
}
/**
 * The host lock at `path`, held by this process for `delivery.queue.lockTtlMinutes`; a holder whose process ended is
 * stale. Every step that takes it or shares the host passes its memory gate first: free memory over
 * `delivery.queue.memoryFloorMb` plus the step's reserve (`heavyReserveMb` at least for a step that takes the lock),
 * and the commit charge under `open.headroom.commitMaxPct` with the reserve counted. A waiter's ticket says what it
 * waits on with the times on `zone`'s clock.
 */
export function hostLockOf(runtime, path, queue, headroom, zone) {
    const memory = new MemoryGate(runtime.memory, runtime.sleep, { floorMb: queue.memoryFloorMb, heavyReserveMb: queue.heavyReserveMb, commitMaxPct: headroom.commitMaxPct });
    return lockAt(runtime, path, queue.lockTtlMinutes * MINUTE_MS, zone, memory);
}
/** The lock the deploy freezes' writers share at `path`, held for a minute, since a write takes moments; it guards no step, so no memory gate. */
export function freezesLockOf(runtime, path, zone) {
    return lockAt(runtime, path, FREEZES_LOCK_TTL_MS, zone, undefined);
}
function lockAt(runtime, path, ttlMs, zone, memory) {
    return new HostLock(path, ttlMs, {
        files: runtime.files,
        clock: runtime.clock,
        sleep: runtime.sleep,
        pid: runtime.pid,
        alive: (pid) => runtime.sessionProcesses.alive(pid),
        newId: () => runtime.newId(),
        zone,
        ...(memory === undefined ? {} : { memory }),
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
