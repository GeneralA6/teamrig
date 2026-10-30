import { FileLock, type LockTimings } from '../core/lock.ts';
import type { CliRuntime } from './runtime.ts';

/** The runtime parts a cross-process file lock needs. */
export type FileLockRuntime = Pick<CliRuntime, 'files' | 'clock' | 'sleep' | 'pid' | 'newId'>;

/** The cross-process lock at `path` (src/core/lock.ts), on the runtime's files, clock, process and ids. */
export function fileLockOf(runtime: FileLockRuntime, path: string, timings: LockTimings): FileLock {
  return new FileLock(path, timings, { files: runtime.files, clock: runtime.clock, sleep: runtime.sleep, pid: runtime.pid, newId: () => runtime.newId() });
}
