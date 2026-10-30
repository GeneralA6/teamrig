import { FileLock } from "../core/lock.js";
/** The cross-process lock at `path` (src/core/lock.ts), on the runtime's files, clock, processes and ids. */
export function fileLockOf(runtime, path, timings) {
    return new FileLock(path, timings, {
        files: runtime.files,
        clock: runtime.clock,
        sleep: runtime.sleep,
        pid: runtime.pid,
        alive: (pid) => runtime.sessionProcesses.alive(pid),
        newId: () => runtime.newId(),
    });
}
