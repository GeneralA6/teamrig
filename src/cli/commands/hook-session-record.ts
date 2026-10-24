import { errorMessage } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { SessionRecordStore } from '../../sessions/record.ts';
import type { Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';

/**
 * Records where session `id` started (src/sessions/record.ts): the tab's Claude Code session and its transcript
 * (undefined: the payload named none), and its Claude Code process, which is this hook's parent, as Claude Code
 * starts its hooks itself (exec form, no shell). It never throws: a failure is the note the start shows, and the
 * next start records again.
 */
export async function recordSessionStart(runtime: CliRuntime, kit: Pick<Kit, 'paths'>, id: string, claudeSession: string, transcript: string | undefined): Promise<string | undefined> {
  try {
    const started = { claudePid: runtime.sessionProcesses.parentPid, claudeSession, at: new Date(runtime.clock.now()).toISOString() };
    const record = transcript === undefined ? started : { ...started, transcript };
    await new SessionRecordStore(runtime.files, kit.paths).write(id, record);
    return undefined;
  } catch (error) {
    return `${KIT_NAME} could not record the Claude Code process of session ${id} (${errorMessage(error)}).`;
  }
}
