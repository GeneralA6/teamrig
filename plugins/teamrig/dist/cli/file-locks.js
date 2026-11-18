import { FileLock } from "../core/lock.js";
/**
 * The cross-process lock at `path` (src/core/lock.ts), on the runtime's files, clock, processes and ids; in a hook,
 * its waits end by the hook's lock deadline (#737).
 */
export function fileLockOf(runtime, path, timings) {
    return new FileLock(path, timings, {
        files: runtime.files,
        clock: runtime.clock,
        sleep: runtime.sleep,
        pid: runtime.pid,
        alive: (pid) => runtime.sessionProcesses.alive(pid),
        newId: () => runtime.newId(),
        deadline: runtime.lockDeadline,
    });
}
