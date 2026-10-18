import { HostLock } from "../coordinator/host-lock.js";
const MINUTE_MS = 60_000;
/** A progress line stamped with the time, since a coordinator command mostly runs in the background with its output in a log. */
export function logLine(runtime, text) {
    runtime.out.stdout(`${new Date(runtime.clock.now()).toISOString()} ${text}`);
}
/** The host lock at `path`, held by this process for `coordinator.heavy.lockTtlMinutes`; a holder whose process ended is stale. */
export function hostLockOf(runtime, path, heavy) {
    return new HostLock(path, heavy.lockTtlMinutes * MINUTE_MS, {
        files: runtime.files,
        clock: runtime.clock,
        sleep: runtime.sleep,
        pid: runtime.pid,
        alive: (pid) => runtime.sessionProcesses.alive(pid),
        newId: () => runtime.newId(),
    });
}
