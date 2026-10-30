import { join } from 'node:path';
import type { TeamPaths } from '../core/home.ts';
import { asksFolderOf } from '../wake/asks.ts';

/**
 * The files and folders a team keeps for one session, each named from its id by the store that writes it. A team
 * split (team-split.ts) moves them with the session into the child team; a store that adds a per-session file adds
 * it here too.
 */
export function sessionFilesOf(paths: TeamPaths, id: string): string[] {
  return [
    // InboxDir, src/inbox/store.ts
    join(paths.inbox, `${id}.md`),
    // RefreshStore, src/refresh/store.ts: the handover the session writes before a refresh, the refresh phase, a
    // restart, a request and what a refresh carried
    join(paths.handover, `${id}.md`),
    ...['json', 'restart.json', 'request.json', 'carried.json'].map((suffix) => join(paths.refresh, `${id}.${suffix}`)),
    // ModelNoticeStore, src/hooks/model-notices.ts
    join(paths.modelNotices, `${id}.json`),
    // UsageStore, src/budget/store.ts, and WarnStore, src/budget/warn-store.ts
    join(paths.usage, `${id}.json`),
    join(paths.warn, `${id}.json`),
    // SessionAskStore, src/core/session-asks.ts
    join(paths.lastTaskAsks, `${id}.json`),
    join(paths.keepWorkingAsks, `${id}.json`),
    // WakeStore and its lock, src/wake/store.ts, and WakePrompts, src/wake/prompts.ts
    ...['json', 'lock', 'prompt.json'].map((suffix) => join(paths.wake, `${id}.${suffix}`)),
    // WakeAsks, src/wake/asks.ts, and TurnLog, src/turn-log/store.ts: a folder each
    asksFolderOf(paths.wakeAsks, id),
    join(paths.turnLog, id),
    // SessionRecordStore, src/sessions/record.ts
    join(paths.sessions, `${id}.json`),
    // the settings a session is launched with, src/cli/skill-listing.ts
    join(paths.launchSettings, `${id}.settings.json`),
  ];
}
