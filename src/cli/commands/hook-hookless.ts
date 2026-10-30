import { readLines } from '../../budget/cursor.ts';
import type { KitConfig } from '../../config/types.ts';
import { KIT_NAME, resolveKitHome } from '../../core/home.ts';
import { indexMarks } from '../../inbox/marks.ts';
import {
  checkedState,
  formatHooklessState,
  HOOKLESS_TAIL_BYTES,
  hooklessLine,
  hooklessNews,
  hooklessReader,
  hooklessTabs,
  isCheckDue,
  lastReplyAt,
  parseHooklessState,
  staleEntries,
  workedPastHook,
  type HooklessState,
  type HooklessTab,
} from '../../restore/hookless.ts';
import { RestoreRegistry, restoreSessionsDir } from '../../restore/registry.ts';
import { postToHolder, sessionNameOn } from '../holder-team.ts';
import { teamZone, type Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';
import { fileLockOf } from '../file-locks.ts';

async function readState(runtime: CliRuntime, kit: Kit): Promise<HooklessState | undefined> {
  return parseHooklessState((await runtime.files.read(kit.paths.hookless)) ?? '');
}

/** The main thread's last reply in the end of a transcript (`HOOKLESS_TAIL_BYTES`); undefined with no file or no reply there. */
async function replyAtEnd(runtime: CliRuntime, path: string): Promise<number | undefined> {
  const size = await runtime.transcripts.size(path);
  if (size === undefined) {
    return undefined;
  }
  const offset = Math.max(0, size - HOOKLESS_TAIL_BYTES);
  const { lines } = await readLines(runtime.transcripts, path, offset, size, HOOKLESS_TAIL_BYTES);
  // A read from inside the file starts mid-line.
  return lastReplyAt(offset === 0 ? lines : lines.slice(1));
}

/**
 * The team's tabs that run without their hooks now: the stale restore entries of its sessions whose transcript
 * ends in a turn long past the last hook. A file's change time only picks the transcripts worth reading: an idle
 * tab's moves too.
 */
async function findHooklessTabs(runtime: CliRuntime, kit: Kit, config: KitConfig, now: number): Promise<HooklessTab[]> {
  const registry = new RestoreRegistry(runtime.files, restoreSessionsDir(resolveKitHome(runtime.env, runtime.userHome)));
  const { marks } = await inboxDepsOf(runtime, kit.paths).marks.read();
  const team = { team: kit.paths.team, sessions: config.sessions, areaBySession: indexMarks(marks).areaBySession };
  const stale = staleEntries(await registry.list(), team, now);
  const replies = new Map<string, number>();
  for (const { entry } of stale) {
    const path = entry.transcriptPath;
    const changed = path === undefined ? undefined : await runtime.transcripts.changedAt(path);
    const found = path === undefined || changed === undefined || !workedPastHook(entry.updatedAt, changed, now) ? undefined : await replyAtEnd(runtime, path);
    if (found !== undefined) {
      replies.set(entry.claudeSession, found);
    }
  }
  return hooklessTabs(stale, replies, now);
}

/**
 * The Stop hook's hookless-tab check: once every `HOOKLESS_CHECK_MS` across the team, claimed under a lock no
 * hook waits for, it reads the team's restore entries whose hooks last wrote over `HOOKLESS_MS` ago, stats their
 * transcripts and reads the end of each that moved since, then posts one inbox line for each tab that started
 * running turns without its hooks to the lead
 * (the coordinator's owner for the lead's own tab), from teamrig. A turn end that is not due reads one small
 * file. A tab with no hook since its start has no entry and is not seen (the idle pass names a reopened one,
 * src/cli/hookless-reopen.ts); nor is any tab while no tab of the team
 * has its hooks. It returns the lines not posted (a secret pattern, a reader's team above with no config), for the
 * caller to drop or show.
 */
export async function checkHooklessTabs(runtime: CliRuntime, kit: Kit, config: KitConfig): Promise<string[]> {
  const now = runtime.clock.now();
  if (!isCheckDue(await readState(runtime, kit), now)) {
    return [];
  }
  const lock = fileLockOf(runtime, kit.paths.hooklessLock, { ...config.lock, waitMs: 0 });
  const news = await lock.run(async () => {
    const state = await readState(runtime, kit);
    if (!isCheckDue(state, now)) {
      return [];
    }
    const tabs = await findHooklessTabs(runtime, kit, config, now);
    await runtime.files.write(kit.paths.hookless, formatHooklessState(checkedState(now, tabs)));
    return hooklessNews(state, tabs);
  });
  const team = kit.paths.team;
  const zone = teamZone(config, runtime);
  const refused: string[] = [];
  for (const tab of news) {
    const to = hooklessReader(tab, config.roles, team);
    const text = hooklessLine(tab, sessionNameOn(to.team, team, tab.session), zone, now);
    const problem = await postToHolder(runtime, { kit, config }, to, { from: KIT_NAME, text });
    if (problem !== undefined) {
      refused.push(`INBOX ${sessionNameOn(team, to.team, to.id)}: not posted: ${problem}`);
    }
  }
  return refused;
}
