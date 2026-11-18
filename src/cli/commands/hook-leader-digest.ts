import { LeadTree } from '../../config/lead-tree.ts';
import type { KitConfig } from '../../config/types.ts';
import type { TeamPaths } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { cursorAfter, DigestCursorStore, digestLines, type DigestCursor } from '../../hooks/leader-digest.ts';
import type { RegisterEvent } from '../../register/events.ts';
import { windowOpensAfter } from '../../register/snapshot.ts';
import { JsonlEventLog } from '../../register/store.ts';
import type { CliRuntime } from '../runtime.ts';

/**
 * The cursor once the digest read `events`. A read of the whole history, made because the cursor stood before the
 * working set's event window (`windowFrom`), moves the cursor at least to that window's start, where the working set
 * holds every event from on: a cursor left before it would read the whole history at every prompt.
 */
function nextCursor(events: readonly RegisterEvent[], windowFrom: string | undefined): DigestCursor | undefined {
  const after = cursorAfter(events);
  return windowFrom !== undefined && (after === undefined || Date.parse(after.at) < Date.parse(windowFrom)) ? { at: windowFrom, seen: 0 } : after;
}

/**
 * The prompt hook's leader digest (hooks/leader-digest.ts) for the team session `id`: undefined, reading and writing
 * nothing, while `register.leaderDigest` is off or for a session that leads no one (a member). A leader's first
 * prompt only sets its cursor past the register's newest event, so it is never shown the whole history. A cursor
 * before the working set's event window (a snapshot of task lines keeps two days of events, T4076) reads the history.
 * The cursor moves before the text is printed, as the inbox lines are marked shown when read: a hook killed at its
 * timeout loses those changes rather than showing them twice. It posts no line and asks no wake: the leader sees it at
 * its own next prompt.
 */
export async function leaderDigestText(runtime: Pick<CliRuntime, 'files' | 'clock'>, paths: Pick<TeamPaths, 'events' | 'leaderDigest'>, config: KitConfig, id: string): Promise<string | undefined> {
  const leaders = new LeadTree(config);
  if (!config.register.leaderDigest || !leaders.isLeader(id)) {
    return undefined;
  }
  const log = new JsonlEventLog(runtime.files, paths.events);
  const working = await log.read();
  const store = new DigestCursorStore(runtime.files, paths.leaderDigest);
  const since = await store.read(id);
  if (since === undefined) {
    await store.write(id, cursorAfter(working.read.events) ?? { at: new Date(runtime.clock.now()).toISOString(), seen: 0 });
    return undefined;
  }
  const fromHistory = windowOpensAfter(working, Date.parse(since.at));
  const { state, read, window } = fromHistory ? await log.readHistory() : working;
  const after = nextCursor(read.events, fromHistory ? working.window?.from : undefined);
  const secrets = new SecretScanner(config.register.secretPatterns);
  const isSecret = (text: string): boolean => secrets.find(text) !== undefined;
  const lines = digestLines({ events: read.events, atStart: window?.tasks ?? new Map(), tasks: state.tasks, since, leader: id, tree: new Set([id, ...leaders.groupOf(id)]), isSecret });
  if (after !== undefined && (after.at !== since.at || after.seen !== since.seen)) {
    await store.write(id, after);
  }
  return lines.length === 0 ? undefined : lines.join('\n');
}
