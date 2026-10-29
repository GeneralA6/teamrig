import { errorMessage } from '../core/guards.ts';
import { resolveKitHome, type TeamPaths } from '../core/home.ts';
import { endAndWait, tabProcessOf } from '../open/end-tab.ts';
import { RestoreRegistry, restoreSessionsDir } from '../restore/registry.ts';
import { SessionLog } from '../sessions/log.ts';
import { enderOf, type Closable } from './idle-check.ts';
import type { CliRuntime } from './runtime.ts';

/** One close: the session, who closes it, and what its verdict found closable. */
export interface Closing {
  readonly id: string;
  readonly by: string;
  readonly closable: Closable;
}

/**
 * Ends a closable session's Claude Code and its tab (asked, then forced: up to about 20 s) and logs the close in
 * `state/session-log.jsonl`, which `teamrig open` resumes from; why it was not closed, or undefined once it is. It
 * drops the session's restore entry too, as an end Claude Code records itself does: ending the tab leaves Claude Code
 * no time to record one, so a reboot's restore would take the closed session for one the shutdown killed (T1425).
 */
export async function closeSession(runtime: CliRuntime, paths: Pick<TeamPaths, 'sessionLog'>, closing: Closing): Promise<string | undefined> {
  const { id, by, closable } = closing;
  const ender = enderOf(runtime);
  const problem = await endAndWait(ender, await tabProcessOf(ender, closable.claude), closable.claude.pid);
  if (problem !== undefined) {
    return problem;
  }
  await new SessionLog(runtime.files, paths.sessionLog).append({
    kind: 'close',
    session: id,
    by,
    at: new Date(runtime.clock.now()).toISOString(),
    claudeSession: closable.record.claudeSession,
    idleMinutes: closable.idleMinutes,
    freedMb: closable.heldMb,
    folder: closable.folder,
  });
  await dropRestoreEntry(runtime, id, closable.record.claudeSession);
  return undefined;
}

/** Takes a closed session off the restore registry; a failure only warns, as the session is closed and logged by then. */
async function dropRestoreEntry(runtime: CliRuntime, id: string, claudeSession: string): Promise<void> {
  try {
    await new RestoreRegistry(runtime.files, restoreSessionsDir(resolveKitHome(runtime.env, runtime.userHome))).remove(claudeSession);
  } catch (error) {
    runtime.out.stderr(`WARN the restore entry of ${id} was not dropped, so a reboot's restore may reopen it: ${errorMessage(error)}`);
  }
}
