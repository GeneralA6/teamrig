import { LAUNCHER_INSTALL_LOCK, launcherRecordPath } from '../restore/launcher-refresh.ts';
import type { ParsedArgs } from './args.ts';
import { fileLockOf } from './file-locks.ts';
import type { CliRuntime, ExitCode } from './runtime.ts';

/**
 * Runs `task` under the launcher record's lock when --yes writes, so an install or uninstall of a launcher never
 * interleaves with the refresh at a session start (src/restore/launcher-refresh.ts); a preview writes nothing, so it
 * takes no lock.
 */
export async function underRecordLock(args: ParsedArgs, runtime: CliRuntime, kitHome: string, task: () => Promise<ExitCode>): Promise<ExitCode> {
  if (!args.switches.has('yes')) {
    return task();
  }
  return fileLockOf(runtime, `${launcherRecordPath(kitHome)}.lock`, LAUNCHER_INSTALL_LOCK).run(task);
}
