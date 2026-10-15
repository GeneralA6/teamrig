import type { TeamPaths } from '../../core/home.ts';
import type { Task } from '../../register/fold.ts';
import { JsonlEventLog } from '../../register/store.ts';
import { verifyQueue } from '../../register/verify.ts';
import { formatVerifySummary } from '../../register/views.ts';
import type { CliRuntime } from '../runtime.ts';

/**
 * The verifying tasks of session `id`, oldest first, from the working set of the team's register log
 * alone: no lock and no archive (a compaction retires only finished tasks), so a hook can afford it.
 */
async function queueOf(runtime: CliRuntime, paths: TeamPaths, id: string): Promise<Task[]> {
  const snapshot = await new JsonlEventLog(runtime.files, paths.events).read();
  return verifyQueue(snapshot.state.tasks.values(), id);
}

/**
 * `VERIFY <n>: T1 (proof: ...), ...` for a session with verifying tasks, for its start context and
 * `inbox read`; undefined for none, and when the register cannot be read, so its caller never fails on it.
 */
export async function verifyNoteOf(runtime: CliRuntime, paths: TeamPaths, id: string | undefined): Promise<string | undefined> {
  if (id === undefined) {
    return undefined;
  }
  try {
    return formatVerifySummary(await queueOf(runtime, paths, id));
  } catch {
    return undefined;
  }
}
