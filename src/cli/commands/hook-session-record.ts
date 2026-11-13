import { errorMessage } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { SessionRecordStore } from '../../sessions/record.ts';
import type { Kit } from '../kit.ts';
import { isLiveRunOwn, liveRunOf, type LiveRun } from '../live-run.ts';
import type { CliRuntime } from '../runtime.ts';

/** What recording a session's start has to say; both undefined when it recorded it, or kept it silently. */
export interface StartRecordNotes {
  /** For the user: why the start's Claude Code process could not be recorded. */
  readonly failure: string | undefined;
  /** For the user and the session: this Claude Code is a second one of a session that runs in another, so it stops. */
  readonly duplicate: string | undefined;
}

const RECORDED: StartRecordNotes = { failure: undefined, duplicate: undefined };

/**
 * Records where session `id`, of a team whose sessions are `ids`, started (src/sessions/record.ts): the tab's Claude
 * Code session and its transcript (undefined: the payload named none), and its Claude Code process, which is this
 * hook's parent, as Claude Code starts its hooks itself (exec form, no shell). While the session runs in another
 * Claude Code process it keeps that one's record, so wakes and closes still find the live tab: a Claude Code that one
 * started, such as a `claude -p` run inside the session, or a fork or background job of the same conversation, says
 * nothing, and any other is told to stop. It never
 * throws: a failure is the note the start shows, and the next start records again.
 */
export async function recordSessionStart(
  runtime: CliRuntime,
  kit: Pick<Kit, 'paths'>,
  ids: readonly string[],
  id: string,
  claudeSession: string,
  transcript: string | undefined,
): Promise<StartRecordNotes> {
  try {
    const claudePid = runtime.sessionProcesses.parentPid;
    const live = await liveRunOf(runtime, kit.paths, ids, id, claudePid);
    if (live !== undefined) {
      // Its own tree, a fork of its conversation or the background job it handed it to is no second one.
      return { failure: undefined, duplicate: (await isLiveRunOwn(runtime, live, claudePid)) ? undefined : duplicateText(id, claudePid, live) };
    }
    const started = { claudePid, claudeSession, at: new Date(runtime.clock.now()).toISOString() };
    const record = transcript === undefined ? started : { ...started, transcript };
    await new SessionRecordStore(runtime.files, kit.paths).write(id, record);
    return RECORDED;
  } catch (error) {
    return { failure: `${KIT_NAME} could not record the Claude Code process of session ${id} (${errorMessage(error)}).`, duplicate: undefined };
  }
}

/** The line that stops Claude Code `claudePid`, a second one of session `id`, which runs in `live`. */
function duplicateText(id: string, claudePid: number, live: LiveRun): string {
  return (
    `STOP: session ${id} already runs in Claude Code process ${live.claudePid}, so this Claude Code (process ${claudePid}) is a second one, ` +
    `which would work beside it on the same tasks; ${KIT_NAME} kept the session's record on the first. Do no work here: tell the user to use that tab and close this one.`
  );
}
