import type { KitConfig } from '../../config/types.ts';
import { ENV, type Env } from '../../core/home.ts';
import { writableObject } from '../../core/jsonl.ts';
import type { FileLock } from '../../core/lock.ts';
import { SecretScanner } from '../../core/secrets.ts';
import {
  addedLines,
  claimState,
  failureNews,
  finishState,
  formatSyncState,
  isDue,
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
 * The automatic GitHub sync: the Stop hook starts `issue sync --auto` hidden in the background once per
 * `github.everyMinutes` for the whole team, claimed under one lock, and that run tells each owner's inbox
 * the tasks it added, and the lead's when the failing repositories change or an outsider's issue is newly left
 * out. Nothing else keeps running.
 */

/** `TEAMRIG_GITHUB=off` turns the import off on this machine, whatever the team config says. */
export const GITHUB_OFF = 'off';

export function githubOff(env: Env): boolean {
  return env[ENV.github]?.trim().toLowerCase() === GITHUB_OFF;
}

/** The lock around the sync state file; a hook does not wait for it, a finishing sync does. */
function stateLock(runtime: CliRuntime, kit: Kit, config: KitConfig, waitMs: number): FileLock {
  return fileLockOf(runtime, kit.paths.githubSyncLock, { ...config.lock, waitMs });
}

async function readState(runtime: CliRuntime, kit: Kit): Promise<SyncState | undefined> {
  return parseSyncState((await runtime.files.read(kit.paths.githubSync)) ?? '');
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
 * The Stop hook's part: once `github.everyMinutes` passed since the last automatic sync, claims the next one
 * and starts `issue sync --auto` hidden, for the team the hook runs for, so the hook neither prints nor waits. A
 * turn end that is not due reads one small file; the claim is checked again under the lock, which a hook
 * never waits for (another session's hook holding it is claiming the same sync). A start that fails is
 * retried at the next interval.
 */
export async function startAutoSync(runtime: CliRuntime, kit: Kit, config: KitConfig): Promise<void> {
  const { github } = config;
  if (github.repos.length === 0 || github.everyMinutes === 0 || githubOff(runtime.env)) {
    return;
  }
  const now = runtime.clock.now();
  if (!isDue(await readState(runtime, kit), now, github.everyMinutes)) {
    return;
  }
  const claimed = await stateLock(runtime, kit, config, 0).run(async () => {
    const state = await writableState(runtime, kit);
    if (!isDue(state, now, github.everyMinutes)) {
      return false;
    }
    await runtime.files.write(kit.paths.githubSync, formatSyncState(claimState(state, now)));
    return true;
  });
  if (claimed) {
    await runtime.processes.startHidden({
      command: runtime.self.node,
      args: [runtime.self.script, 'issue', 'sync', '--auto'],
      cwd: kit.paths.home,
      env: { ...runtime.env, [ENV.team]: kit.paths.team },
    });
  }
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
