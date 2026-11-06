import type { Sleep } from '../core/lock.ts';
import type { ProcessInfo } from '../open/session-processes.ts';
import type { CliHarness } from './cli-harness.ts';

/** Another tab's teamrig, which holds a file lock (src/core/lock.ts) in a spec. */
export const LOCK_HOLDER: ProcessInfo = { pid: 9100, parentPid: 1, name: 'node', commandLine: 'node teamrig hook' };

/**
 * Writes the lock at `path` as LOCK_HOLDER took it at `at` (default now) and runs LOCK_HOLDER in the kit's process
 * table, so a run waits for the lock rather than taking over a dead holder's.
 */
export async function holdFileLock(kit: CliHarness, path: string, at: number = kit.clock.now()): Promise<void> {
  kit.sessionProcesses.add(LOCK_HOLDER);
  await kit.files.write(path, JSON.stringify({ pid: LOCK_HOLDER.pid, at, id: 'held' }));
}

/** A wait on the lock at `path`, held by LOCK_HOLDER: it notes what `watched` holds at each wait, and the holder lets go at the first. */
export function holderLetsGo(kit: CliHarness, path: string, watched: string, seen: Array<string | undefined>): Sleep {
  return async (ms) => {
    seen.push(kit.files.get(watched));
    await kit.files.remove(path);
    await kit.clock.sleep(ms);
  };
}
