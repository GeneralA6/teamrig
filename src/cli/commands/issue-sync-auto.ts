import type { KitConfig } from '../../config/types.ts';
import { ENV, type Env } from '../../core/home.ts';
import { writableObject } from '../../core/jsonl.ts';
import type { FileLock } from '../../core/lock.ts';
import { SecretScanner } from '../../core/secrets.ts';
import {
  addedLines,
  failureNews,
  finishState,
  formatSyncState,
  leftOutNews,
  parseSyncState,
  SYNC_STATE_FORMAT,
  type SyncRun,
  type SyncState,
} from '../../github/auto.ts';
import { postLine } from '../../inbox/inbox.ts';
import { GITHUB_ACTOR } from '../../register/policy.ts';
import type { Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';
import { fileLockOf } from '../file-locks.ts';

/**
 * The automatic GitHub sync's report: `issue watch` (issue-watch.ts) runs `issue sync --auto` when GitHub changed,
 * and that run tells each owner's inbox the tasks it added, and the lead's when the failing repositories change or an
 * outsider's issue is newly left out.
 */

/** `TEAMRIG_GITHUB=off` turns the import off on this machine, whatever the team config says. */
export const GITHUB_OFF = 'off';

export function githubOff(env: Env): boolean {
  return env[ENV.github]?.trim().toLowerCase() === GITHUB_OFF;
}

/** The lock around the sync state file, held while a finishing sync records its end. */
function stateLock(runtime: CliRuntime, kit: Kit, config: KitConfig, waitMs: number): FileLock {
  return fileLockOf(runtime, kit.paths.githubSyncLock, { ...config.lock, waitMs });
}

/**
 * The state before a write, under the lock. A file a newer teamrig wrote is refused (`NewerDataError`), so an older
 * teamrig still running in some tab never drops its fields: its hook starts no sync, its `issue sync --auto` fails.
 */
async function writableState(runtime: CliRuntime, kit: Kit): Promise<SyncState | undefined> {
  const text = await runtime.files.read(kit.paths.githubSync);
  writableObject(kit.paths.githubSync, text, SYNC_STATE_FORMAT);
  return parseSyncState(text ?? '');
}

/**
 * What `issue sync --auto` does once it has written: records its finish, failing repositories and left-out issues,
 * then posts one inbox line to each owner naming the tasks added for it, one to the lead when the failing
 * repositories changed (`failureNews`) and one when an outsider's issue was left out that was not before
 * (`leftOutNews`). It gives a line for each inbox line that was refused, such as an issue title that matches a
 * secret pattern.
 */
export async function reportAutoSync(runtime: CliRuntime, kit: Kit, config: KitConfig, run: SyncRun): Promise<string[]> {
  const now = runtime.clock.now();
  const { before, after } = await stateLock(runtime, kit, config, config.lock.waitMs).run(async () => {
    const state = await writableState(runtime, kit);
    const finished = finishState(state, now, run.failures, run.leftOut);
    await runtime.files.write(kit.paths.githubSync, formatSyncState(finished));
    return { before: state, after: finished };
  });
  const posts = [...addedLines(run.added)].map(([to, text]) => ({ to, text }));
  const news = [failureNews(before?.failing ?? [], run.failures), leftOutNews(before?.leftOut ?? new Map(), after.leftOut, config.github.acceptLabel)];
  for (const text of news) {
    if (text !== undefined) {
      posts.push({ to: config.roles.lead, text });
    }
  }
  const inboxes = inboxDepsOf(runtime, kit.paths).inboxes;
  const secrets = new SecretScanner(config.register.secretPatterns);
  const refused: string[] = [];
  for (const { to, text } of posts) {
    const problem = await postLine(inboxes, secrets, { to, from: GITHUB_ACTOR, text, now: new Date(now) });
    if (problem !== undefined) {
      refused.push(`INBOX ${to}: not posted: ${problem}`);
    }
  }
  return refused;
}
