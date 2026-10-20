import { DEFAULT_LOCK } from "../config/defaults.js";
import { AgedLogFile } from "../core/aged-log.js";
import { FileLock } from "../core/lock.js";
/** The hooks' dedup logs: what they showed each Claude Code session, so each inbox line or hint is shown once. */
export const DEDUP_LOGS = ['inbox-shown', 'bind-hints'];
function filesOf(paths, log) {
    return log === 'inbox-shown' ? { live: paths.inboxShown, lock: paths.inboxShownLock } : { live: paths.bindHints, lock: paths.bindHintsLock };
}
/**
 * A dedup log, locked on every write and archived by age (core/aged-log.ts, T336). Its lock keeps the default
 * timings, not the team's `lock`: the session-start hook writes bind-hints when no config loads, and every writer
 * of one lock must agree on when a held lock is stale.
 */
export function dedupLogOf(runtime, paths, log) {
    const { files, clock, sleep, pid } = runtime;
    const { live, lock } = filesOf(paths, log);
    return new AgedLogFile({ files, clock, mutex: new FileLock(lock, DEFAULT_LOCK, { files, clock, sleep, pid }) }, { live, archive: paths.archive, name: log });
}
