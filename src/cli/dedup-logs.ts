import { DEFAULT_LOCK } from '../config/defaults.ts';
import { AgedLogFile } from '../core/aged-log.ts';
import type { TeamPaths } from '../core/home.ts';
import { FileLock } from '../core/lock.ts';
import type { CliRuntime } from './runtime.ts';

/** The hooks' dedup logs: what they showed each Claude Code session, so each inbox line or hint is shown once. */
export const DEDUP_LOGS = ['inbox-shown', 'bind-hints'] as const;
export type DedupLog = (typeof DEDUP_LOGS)[number];

function filesOf(paths: TeamPaths, log: DedupLog): { readonly live: string; readonly lock: string } {
  return log === 'inbox-shown' ? { live: paths.inboxShown, lock: paths.inboxShownLock } : { live: paths.bindHints, lock: paths.bindHintsLock };
}

/**
 * A dedup log, locked on every write and archived by age (core/aged-log.ts, T336). Its lock keeps the default
 * timings, not the team's `lock`: the session-start hook writes bind-hints when no config loads, and every writer
 * of one lock must agree on when a held lock is stale.
 */
export function dedupLogOf(runtime: CliRuntime, paths: TeamPaths, log: DedupLog): AgedLogFile {
  const { files, clock, sleep, pid } = runtime;
  const { live, lock } = filesOf(paths, log);
  return new AgedLogFile({ files, clock, mutex: new FileLock(lock, DEFAULT_LOCK, { files, clock, sleep, pid }) }, { live, archive: paths.archive, name: log });
}
