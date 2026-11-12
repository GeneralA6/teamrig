import { LeadTree } from '../../config/lead-tree.ts';
import type { KitConfig } from '../../config/types.ts';
import type { TeamPaths } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { cursorAfter, DigestCursorStore, digestLines } from '../../hooks/leader-digest.ts';
import { JsonlEventLog } from '../../register/store.ts';
import type { CliRuntime } from '../runtime.ts';

/**
 * The prompt hook's leader digest (hooks/leader-digest.ts) for the team session `id`: undefined for a session that leads
 * no one (a member), which reads and writes nothing. A leader's first prompt only sets its cursor past
 * the register's newest event, so it is never shown the whole history. The cursor moves before the text is printed, as the
 * inbox lines are marked shown when read: a hook killed at its timeout loses those changes rather than showing them twice.
 * It posts no line and asks no wake: the leader sees it at its own next prompt.
 */
export async function leaderDigestText(runtime: Pick<CliRuntime, 'files' | 'clock'>, paths: Pick<TeamPaths, 'events' | 'leaderDigest'>, config: KitConfig, id: string): Promise<string | undefined> {
  const leaders = new LeadTree(config);
  if (!leaders.isLeader(id)) {
    return undefined;
  }
  const { state, read } = await new JsonlEventLog(runtime.files, paths.events).read();
  const store = new DigestCursorStore(runtime.files, paths.leaderDigest);
  const since = await store.read(id);
  const after = cursorAfter(read.events);
  if (since === undefined) {
    await store.write(id, after ?? { at: new Date(runtime.clock.now()).toISOString(), seen: 0 });
    return undefined;
  }
  const secrets = new SecretScanner(config.register.secretPatterns);
  const isSecret = (text: string): boolean => secrets.find(text) !== undefined;
  const lines = digestLines({ events: read.events, tasks: state.tasks, since, leader: id, tree: new Set([id, ...leaders.groupOf(id)]), isSecret });
  if (after !== undefined && (after.at !== since.at || after.seen !== since.seen)) {
    await store.write(id, after);
  }
  return lines.length === 0 ? undefined : lines.join('\n');
}
