import { treeOf } from '../delivery/processes.ts';
import { KIT_NAME, type TeamPaths } from '../core/home.ts';
import { runsClaude } from '../open/session-processes.ts';
import { measureSessions, runningPlaces } from '../sessions/measure.ts';
import { SessionRecordStore, type SessionRecord } from '../sessions/record.ts';
import { RefusedError, type CliRuntime } from './runtime.ts';

/**
 * Session `id`'s start record while its Claude Code runs now, of a team whose sessions are `ids`; undefined when it runs
 * in none. Every session's record counts: a later one on the same process (a /clear that bound the tab to it) wins it.
 * Refused when the host's processes cannot be listed, since then nothing tells whether it runs.
 */
export async function runningRecordOf(runtime: Pick<CliRuntime, 'files' | 'memory'>, paths: Pick<TeamPaths, 'sessions'>, ids: readonly string[], id: string): Promise<SessionRecord | undefined> {
  const records = await new SessionRecordStore(runtime.files, paths).readEach(ids);
  const rows = await runtime.memory.processes();
  if (rows === undefined) {
    throw new RefusedError(`${KIT_NAME} could not list the host's processes, so it cannot tell whether ${id} runs`);
  }
  return runningPlaces(measureSessions(records, rows)).some((place) => place.id === id) ? records.get(id) : undefined;
}

/** The Claude Code process a session runs in now, and the processes within its tree, such as a `claude -p` it ran. */
export interface LiveRun {
  readonly claudePid: number;
  /** `claudePid` and every process it started, and they started, that still runs. */
  readonly tree: ReadonlySet<number>;
}

/**
 * The Claude Code process session `id`, of a team whose sessions are `ids`, runs in now, unless that is `own`: its
 * recorded process while it still runs Claude Code and, as `teamrig sessions` tells it (src/sessions/measure.ts),
 * started before the record and is recorded by no other session since. Undefined when it runs in none, or the host
 * cannot list its processes; only a recorded process that still runs Claude Code costs that listing.
 */
export async function liveRunOf(
  runtime: Pick<CliRuntime, 'files' | 'sessionProcesses' | 'memory'>,
  paths: Pick<TeamPaths, 'sessions'>,
  ids: readonly string[],
  id: string,
  own?: number,
): Promise<LiveRun | undefined> {
  const records = await new SessionRecordStore(runtime.files, paths).readEach(ids);
  const record = records.get(id);
  if (record === undefined || record.claudePid === own || !(await runsClaude(runtime.sessionProcesses, record.claudePid))) {
    return undefined;
  }
  const rows = await runtime.memory.processes();
  if (rows === undefined) {
    return undefined;
  }
  const place = runningPlaces(measureSessions(records, rows)).find((running) => running.id === id);
  return place === undefined ? undefined : { claudePid: place.claudePid, tree: new Set(treeOf(place.claudePid, rows).map((row) => row.pid)) };
}

/** Why `name` (session `id`) gets no second Claude Code while it runs in `run`. */
export function liveRunText(name: string, id: string, run: LiveRun): string {
  return `${name} (session ${id}) already runs in Claude Code process ${run.claudePid}, and a second one would work beside it on the same tasks: use its tab, or end that one first (${KIT_NAME} sessions lists what runs)`;
}
