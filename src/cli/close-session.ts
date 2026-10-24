import type { TeamPaths } from '../core/home.ts';
import { endAndWait, tabProcessOf } from '../open/end-tab.ts';
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
 * `state/session-log.jsonl`, which `teamrig open` resumes from; why it was not closed, or undefined once it is.
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
  });
  return undefined;
}
