import { readLines } from '../../budget/cursor.ts';
import type { KitConfig } from '../../config/types.ts';
import { KIT_NAME, resolveKitHome } from '../../core/home.ts';
import { FileLock } from '../../core/lock.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { postLine } from '../../inbox/inbox.ts';
import {
  checkedState,
  formatHooklessState,
  HOOKLESS_TAIL_BYTES,
  hooklessLine,
  hooklessNews,
  hooklessReader,
  hooklessTabs,
  isCheckDue,
  parseHooklessState,
  staleEntries,
  tabActivity,
  workedPastHook,
  type HooklessState,
  type HooklessTab,
  type TabActivity,
} from '../../restore/hookless.ts';
import { RestoreRegistry, restoreSessionsDir } from '../../restore/registry.ts';
import { teamZone, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';

async function readState(runtime: CliRuntime, kit: Kit): Promise<HooklessState | undefined> {
  return parseHooklessState((await runtime.files.read(kit.paths.hookless)) ?? '');
}

/** The last reply and reload in the end of a transcript (`HOOKLESS_TAIL_BYTES`); undefined when it has no file. */
async function activityAtEnd(runtime: CliRuntime, path: string): Promise<TabActivity | undefined> {
  const size = await runtime.transcripts.size(path);
  if (size === undefined) {
    return undefined;
  }
  const offset = Math.max(0, size - HOOKLESS_TAIL_BYTES);
  const { lines } = await readLines(runtime.transcripts, path, offset, size, HOOKLESS_TAIL_BYTES);
  // A read from inside the file starts mid-line.
  return tabActivity(offset === 0 ? lines : lines.slice(1));
}

/**
 * The team's tabs that run without their hooks now: its stale restore entries whose transcript ends in a turn long
 * past the last hook. A file's change time only picks the transcripts worth reading: an idle tab's moves too.
 */
async function findHooklessTabs(runtime: CliRuntime, kit: Kit, now: number): Promise<HooklessTab[]> {
  const registry = new RestoreRegistry(runtime.files, restoreSessionsDir(resolveKitHome(runtime.env, runtime.userHome)));
  const stale = staleEntries(await registry.list(), kit.paths.team, now);
  const activity = new Map<string, TabActivity>();
  for (const entry of stale) {
    const path = entry.transcriptPath;
    const changed = path === undefined ? undefined : await runtime.transcripts.changedAt(path);
    const found = path === undefined || changed === undefined || !workedPastHook(entry.updatedAt, changed, now) ? undefined : await activityAtEnd(runtime, path);
    if (found !== undefined) {
      activity.set(entry.claudeSession, found);
    }
  }
  return hooklessTabs(stale, activity, now);
}

/**
 * The Stop hook's hookless-tab check: once every `HOOKLESS_CHECK_MS` across the team, claimed under a lock no
 * hook waits for, it reads the team's restore entries whose hooks last wrote over `HOOKLESS_MS` ago, stats their
 * transcripts and reads the end of each that moved since, then posts one inbox line for each tab that started
 * running turns without its hooks to the lead
 * (the coordinator's owner for the lead's own tab), from teamrig. A turn end that is not due reads one small
 * file. A tab with no hook since its start has no entry and is not seen; nor is any tab while no tab of the team
 * has its hooks. It returns the lines refused (a secret pattern), for the caller to drop or show.
 */
export async function checkHooklessTabs(runtime: CliRuntime, kit: Kit, config: KitConfig): Promise<string[]> {
  const now = runtime.clock.now();
  if (!isCheckDue(await readState(runtime, kit), now)) {
    return [];
  }
  const { files, clock, sleep, pid } = runtime;
  const lock = new FileLock(kit.paths.hooklessLock, { ...config.lock, waitMs: 0 }, { files, clock, sleep, pid });
  const news = await lock.run(async () => {
    const state = await readState(runtime, kit);
    if (!isCheckDue(state, now)) {
      return [];
    }
    const tabs = await findHooklessTabs(runtime, kit, now);
    await runtime.files.write(kit.paths.hookless, formatHooklessState(checkedState(now, tabs)));
    return hooklessNews(state, tabs);
  });
  const inboxes = inboxDepsOf(runtime, kit.paths).inboxes;
  const secrets = new SecretScanner(config.register.secretPatterns);
  const zone = teamZone(config, runtime);
  const refused: string[] = [];
  for (const tab of news) {
    const to = hooklessReader(tab, config.roles.lead, config.roles.coordinatorOwner);
    const problem = await postLine(inboxes, secrets, { to, from: KIT_NAME, text: hooklessLine(tab, (at) => zone.clock(at)), now: new Date(now) });
    if (problem !== undefined) {
      refused.push(`INBOX ${to}: not posted: ${problem}`);
    }
  }
  return refused;
}
